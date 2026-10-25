import { hostname } from "node:os";
import { CapabilityReporter } from "../../capabilities/detect.js";
import { probeRuntimeHealth, type ResourceSample, recordRunnerStart, sampleDisk, sampleMemAvailable, sampleResources } from "./resources.js";
import { createCleanupSync } from "./cleanup-sync.js";
import { sessionToken } from "./session-token.js";
import { AgentRoutePolicy } from "./route-policy.js";
import { loadMachineIdentity } from "../../machine.js";
import { writeError, writeLine } from "../../output.js";
import { apiPathSegment, pagsApiBase, requestPags, requestRunner } from "./http.js";
import { CLI_VERSION, runsFromSource } from "./process.js";
import { deferredUpdateLease, deferredUpdateLeaseActive, installVersion, latestPublishedRelease, leaveForRestart, planRunnerRestart, planRunnerUpdate, restarterFrom, RUNNER_RESTART_PATH, RUNNER_UPDATE_PATH, restartBlockedByInstall, supervisorNote, type DeferredUpdateLease } from "./self-update.js";
import { diffMembership, eligibleIds, relayStatusPath, instanceLabel, pendingRegistrations, pinnedAway, reattachPlan, registrationStatus, shouldRegisterOnOpen, type DiscoverableInstance, type ReattachRequest } from "./membership.js";
import { formatStatusLine } from "./status-line.js";
import type { PagsRequestOptions } from "./types.js";
import { autoUpdatePolicyKey, autoUpdateStatusWire, loadAutoUpdatePolicy, saveAutoUpdatePolicy } from "./auto-update.js";
import { type AutoUpdateDiagnostics, AutomaticUpdateController, boundedWork, RelayMutationAdmission } from "./auto-update-controller.js";
import { readWorkLook } from "./runner-work-observation.js";
import { BoundExpired, createInstallBridge, createPolicyChannel, PolicyCell } from "./update-bridge.js";
import { agentsStillMissing, applyRetryRolledBack, releaseTrial, rollbackAvailable } from "./release-trial.js";
import { updateLogUpload } from "../../bootstrap/update-log.js";
import { restartOwner } from "../up-restart.js";
import { sessionExpiresAt } from "../login-device.js";

/**
 * The one relay command this CLI answers ITSELF rather than forwarding to the local runner (#850):
 * "re-read which agents this machine should hold, now". Sent by the cloud when an agent is repinned,
 * over any socket this process holds — the target machine then attaches the agent in the same call,
 * and a machine it was pinned away from lets go, instead of each waiting for the next 20s poll.
 * The API sends it by this exact string (`workers/api/src/lib/runner-repin.ts`); change both.
 */
export const MEMBERSHIP_SYNC_PATH = "/pags/membership/sync";

/** Every relay command the CLI answers itself rather than forwarding to the local runner. */
const CLI_CONTROL_PATHS = new Set([MEMBERSHIP_SYNC_PATH, RUNNER_UPDATE_PATH, RUNNER_RESTART_PATH]);

/**
 * Connect to PAGS via WebSocket relay — no tunnel, no cloudflared.
 * Opens one WS per instance to the RelayDO and dispatches incoming commands
 * to the local runner HTTP server.
 */
export async function connectViaRelay(
	instanceIds: string[],
	localUrl: string,
	runnerToken: string,
	opts: PagsRequestOptions,
	force = false,
	/** Poll for newly eligible instances and attach them without a restart (#229). Off for a
	 *  scoped `pags up --instance X`, which must stay exactly as narrow as the user asked. */
	watchInstances = false,
): Promise<void> {
	const apiBase = pagsApiBase(opts.apiBase).replace(/^http/, "ws"); // https → wss
	// Read per call, not once (#1157): the session refresher swaps the held session while this runs (#1163).
	const pagsToken = () => sessionToken(opts.pagsToken);
	if (!pagsToken()) throw new Error("PAGS token required for WebSocket relay");
	const runnerNode = hostname();
	// The hostname stays the routing key — it names the relay DO — but it is NOT this machine's
	// identity: it moves with the network. The persisted id is what lets the server recognise a
	// renamed machine as the same one, so a pin made under an old name keeps working (#379).
	const machine = loadMachineIdentity(runnerNode);
	// No persisted machine id means no durable physical identity. Failing closed here prevents a
	// cache shared by two ephemeral containers from becoming a policy identity by accident.
	const autoUpdateKey = machine.id ? autoUpdatePolicyKey(machine.id) : "";
	// The policy record (#1020, update-bridge.ts). A cache is an outage aid, never a second authority: only a fresh
	// service answer confirms the owner's switch; the cache carries the status and the unverified recovery cycle.
	const cell = new PolicyCell(autoUpdateKey ? (loadAutoUpdatePolicy(autoUpdateKey) ?? { autoUpdate: false }) : { autoUpdate: false }, (p) => saveAutoUpdatePolicy(autoUpdateKey, p), !!autoUpdateKey);
	let lastMissingLogged = -1;
	const trial = releaseTrial(CLI_VERSION, cell, writeLine); // #1141: report a rollback; the first answer proves a release on trial
	let scheduleAutomaticUpdate: (initial?: boolean, cancel?: boolean) => void = () => undefined;
	// The controller's own record (#1020), bound once it exists. Times, a normalized blocker class and
	// observation outcomes only — never session text, process arguments, paths, prompts or tokens.
	let autoUpdateDiagnostics: () => Partial<AutoUpdateDiagnostics> = () => ({});
	const updateLog = updateLogUpload(CLI_VERSION); // #1151: the update log lands on the machine's record once per start
	const autoUpdateStatusBody = () => ({
		status: autoUpdateStatusWire(cell.policy.status),
		latestVersion: cell.policy.latestVersion,
		error: cell.policy.reason,
		rollbackAvailable: rollbackAvailable(process.env, runsFromSource()), // #1147: false = this machine updates in place
		rollbacks: trial.rollbacks(), // #1150: durable on the machine page; empty once the owner retries the release
		...updateLog.body(),
		...autoUpdateDiagnostics(),
	});

	// Register the runtime (needed for the status badge / getRunnerConn)
	const capabilities = await requestRunner<{ capabilities?: unknown }>("GET", "/capabilities", { url: localUrl, token: runnerToken, instanceId: instanceIds[0] });
	const caps = Array.isArray(capabilities.capabilities) ? capabilities.capabilities.filter((item): item is string => typeof item === "string") : [];
	// Which instances currently hold a runtime registration from THIS machine (`channel.registered`). Tracked, not
	// assumed: a register that failed at startup used to be lost forever, and the pane still printed a tick (#497).
	let lastRegisterError = "";
	const channel = createPolicyChannel({
		cell,
		post: (path, body, signal) => requestPags<Record<string, unknown>>("POST", path, opts, body, signal),
		body: (_id, forceClaim) => ({
			endpointUrl: localUrl,
			token: runnerToken,
			placement: "local",
			capabilities: caps,
			runnerVersion: CLI_VERSION,
			runnerNode,
			machineId: machine.id,
			machineNames: machine.names,
			force: forceClaim,
			autoUpdateStatus: autoUpdateStatusBody(),
		}),
		force,
		held: () => attached.keys(),
		onError: (id, msg) => {
			lastRegisterError = msg;
			writeError(`register ${id.slice(0, 8)}… failed: ${msg}`);
		},
		onAction: (action) => scheduleAutomaticUpdate(action === "start", action === "cancel"),
		onAnswer: () => {
			// #1154: a release that registered but left the agents it was installed over unattached is not yet proven.
			const missing = agentsStillMissing(cell.policy.recovery, [...attached.keys()].filter((id) => registered.has(id)), shouldHoldNow);
			if (missing.length) {
				if (missing.length !== lastMissingLogged) writeLine(`auto-update: ${CLI_VERSION} answered, but ${missing.length} agent(s) it was installed over are not attached yet — not kept until they are.`);
				lastMissingLogged = missing.length;
			} else trial.proven();
			updateLog.answered();
		},
	});
	const registered = channel.registered;
	const registerRuntime = (id: string, forceClaim = force) => channel.register(id, forceClaim);
	// The live membership set. A captured array is what made a newly subscribed agent
	// unreachable until restart (#229); sockets are now added and removed while running.
	const attached = new Map<string, RelaySocketHandle>();
	let shouldHoldNow: ReadonlySet<string> | null = null;
	// What the heartbeat reports about THIS process (#924): when it started, how often the machine has
	// started a runner lately (a crash loop restarts uptime but not this count), and socket reconnects.
	const processStartedAt = Date.now();
	const starts24h = recordRunnerStart(processStartedAt);
	let relayReconnects = 0;
	// Instances another live runner owns (4409). Kept out of re-attach until the block clears.
	const blocked = new Set<string>();
	/** The membership pass in flight, so the poll and a cloud request queue rather than overlap (#850). */
	let syncing: Promise<void> = Promise.resolve();
	/** Agents whose NEXT socket opens with `force=1`, because the cloud asked for a takeover (#856). */
	const forceNext = new Set<string>();
	/**
	 * Tell the parent TUI what registration actually stands at — see status-line.ts.
	 *
	 * Measured against the LIVE attached set, not `instanceIds` (#810): an agent discovery
	 * detached — a pin moved, an unsubscribe — is not this machine's to register, and counting it
	 * held the light on "partial", and the screen on "Still connecting", for the life of the process.
	 */
	const reportRegistration = () => {
		const { agents, state } = registrationStatus(attached.keys(), registered);
		writeLine(formatStatusLine({ registration: state, agents, reason: state === "ok" ? undefined : lastRegisterError }));
	};
	for (const id of instanceIds) await registerRuntime(id);

	/** The cloud asking for a membership pass now (#850). A scoped run refuses: it must stay as
	 *  narrow as the user asked, and saying so is what lets the repin report the real remedy. */
	/** The facts `runner_update` decides on (#859): versions, how this process runs, which engines are mid-turn. */
	/** The local work look both an update and a restart are guarded by (#1020, #1032). */
	const workLook = async (signal?: AbortSignal) => {
		const [sessionsResult, healthResult] = await Promise.allSettled([
			requestRunner<{ sessions?: Array<{ sessionId: string; alive?: boolean; runState?: string; platformRun?: boolean }> }>("GET", "/coding/sessions", {
			url: localUrl,
			token: runnerToken,
			instanceId: instanceIds[0],
			}, undefined, signal),
			requestRunner<{ work?: { codingTurns?: number; localRuns?: number; detail?: string[] } }>("GET", "/health", { url: localUrl, token: runnerToken, instanceId: instanceIds[0] }, undefined, signal),
		]);
		// The guard's reading and each half's outcome, read ONCE (#1020): a local browser/apply run is destroyed by a restart
		// as surely as a coding turn, so an unavailable or unreadable look fails closed.
		return readWorkLook(sessionsResult, healthResult, Date.now());
	};
	const updateFacts = async (signal?: AbortSignal) => {
		const { busy, observations } = await workLook(signal);
		const release = await latestPublishedRelease(undefined, signal);
		return {
			observations,
			current: CLI_VERSION,
			latest: "version" in release ? release.version : null,
			...("error" in release ? { latestError: release.error } : {}),
			fromSource: runsFromSource(),
			restarter: restarterFrom(process.env),
			rolledBack: trial.rolledBack(),
			// A restart ends browser/application work too. Give these durable names to the same
			// planner so neither manual nor automatic update can mistake them for an idle machine.
			busy,
		};
	};
	// Once an install has finished, no new mutating relay command is admitted while the runner is observed one final
	// time: a coding turn cannot slip in during npm or the restart delay.
	const relayMutationAdmission = new RelayMutationAdmission();
	/**
	 * Install the release, then leave so whatever supervises this process starts it again (#860) — see
	 * `leaveForRestart`. Every wait inside it is bounded (#1020, update-bridge.ts).
	 */
	const bridge = createInstallBridge({
		cell,
		refresh: channel.refresh,
		facts: updateFacts,
		install: (version) => installVersion(version, CLI_VERSION),
		admission: relayMutationAdmission,
		leaseActive: deferredUpdateLeaseActive,
		detachAll: () => {
			for (const id of [...attached.keys()]) detach(id);
		},
		log: writeLine,
	});
	/** A deferred MANUAL update waits for busy engines to finish, re-checking — never cuts a turn off (#859). */
	let updateWaiting = false;
	let deferredManualLease: DeferredUpdateLease | null = null;
	const updateWhenIdle = (lease: DeferredUpdateLease): boolean => {
		if (updateWaiting) return false;
		updateWaiting = true;
		deferredManualLease = lease;
		const tick = () =>
			setTimeout(async () => {
				if (!deferredManualLease || !deferredUpdateLeaseActive(deferredManualLease)) {
					writeLine("runner_update: the deferred operation lease expired; no delayed restart was performed.");
					deferredManualLease = null;
					updateWaiting = false;
					return;
				}
				const facts = await boundedWork((signal) => updateFacts(signal));
				const plan = facts ? planRunnerUpdate(facts) : null;
				if (plan?.action === "update") {
					const installed = await bridge.run(plan, false, deferredManualLease).catch((e) => {
						writeError(`runner_update: install failed — ${e instanceof Error ? e.message : String(e)}`);
						return false;
					});
					if (!installed && Date.now() < lease.expiresAt) tick();
					else {
						deferredManualLease = null;
						updateWaiting = false;
						if (installed) leaveForRestart(plan.restarter);
					}
				} else if ((!plan || plan.action === "wait") && Date.now() < lease.expiresAt) tick(); // an unanswered look is retried, not taken as idle
				else {
					deferredManualLease = null;
					updateWaiting = false;
				}
			}, 15_000).unref();
		tick();
		return true;
	};

	// Never start unattended work from cache alone. A registration/heartbeat answer confers authority and schedules
	// the first jittered check; an offline policy fetch therefore defers. The legacy in-closure checker this replaced
	// was unreachable — and would have reported any current runner `verified_success` (#1020).
	const automaticUpdateController = new AutomaticUpdateController({
		policy: () => ({ value: cell.policy, authoritative: cell.authoritative }),
		refreshPolicy: channel.refresh,
		facts: updateFacts,
		plan: planRunnerUpdate,
		// The same bridge an explicit runner_update uses: npm, a fresh authoritative policy, the mutation drain, the
		// final local-work observation and restart — each wait bounded.
		installAndRestart: async (plan, automatic) => {
			const installed = await bridge.run(plan, automatic);
			// The controller records `restarting` in the microtask after this resolves; leaving on a timer keeps it.
			if (installed) setTimeout(() => leaveForRestart(plan.restarter), 0).unref();
			return installed;
		},
		status: (status, extra) => cell.record(status, extra),
		// The agents held now: attached AND registered — recorded with an install, required back after it.
		attachments: () => [...attached.keys()].filter((id) => registered.has(id)),
		// What the latest membership pass says this machine should hold — an agent repinned or paused since the install is excused (#1170).
		shouldHold: () => shouldHoldNow,
	});
	autoUpdateDiagnostics = () => automaticUpdateController.diagnostics();
	// Startup registration ran before this controller existed; from here every policy transition drives it.
	scheduleAutomaticUpdate = (initial = false, cancel = false) => automaticUpdateController.onPolicy(cancel ? "cancel" : initial ? "start" : "keep");
	if (cell.authoritative && cell.policy.autoUpdate) scheduleAutomaticUpdate(true);
	const answerUpdate = async (body?: unknown): Promise<{ status: number; result: unknown }> => {
		const dryRun = (body as { dryRun?: unknown } | undefined)?.dryRun === true;
		let facts = await boundedWork((signal) => updateFacts(signal));
		if (!facts) return { status: 504, result: { error: "The local work and registry look did not answer within 30s; nothing was installed or restarted." } };
		// #1150: the owner asked to try again the release this machine rolled back from (release-trial.ts clears its bad mark first).
		const retry = applyRetryRolledBack(facts, body, trial, dryRun);
		facts = retry.facts;
		const retried = retry.retried;
		const retriedNote = retried ? { retriedRolledBack: retried } : {};
		const plan = planRunnerUpdate(facts);
		if (dryRun || plan.action === "up-to-date" || plan.action === "refused") return { status: 200, result: { ...plan, dryRun, ...retriedNote } };
		if (plan.action === "wait") {
			const lease = deferredUpdateLease(body);
			if (!lease) return { status: 400, result: { error: "A busy runner_update needs a current operation lease; no delayed restart was scheduled." } };
			if (!updateWhenIdle(lease)) return { status: 409, result: { error: "A runner update is already waiting for active work to finish." } };
			return { status: 200, result: { ...plan, ...retriedNote, operationId: lease.operationId, deferredUntil: lease.expiresAt, detail: "This operation may restart only before its recorded lease expires; no delayed restart survives an expired or terminal operation." } };
		}
		try {
			if (!(await bridge.run(plan))) return { status: 409, result: { error: "A runner update is already installing or restarting." } };
		} catch (e) {
			if (e instanceof BoundExpired) return { status: 504, result: { error: e.message } };
			return { status: 500, result: { error: `npm could not install ${plan.latest}: ${e instanceof Error ? e.message : String(e)}` } };
		}
		const supervisor = supervisorNote(plan.restarter);
		// `openRelaySocket` sends this value before timers run.  Calling `leaveForRestart` above
		// would synchronously exit and make this decisive machine acknowledgement impossible.
		setTimeout(() => leaveForRestart(plan.restarter), 25).unref();
		return { status: 200, result: { action: "restarting", ...retriedNote, current: plan.current, latest: plan.latest, restartedBy: plan.restarter, ...(supervisor ? { supervisor } : {}) } };
	};

	/**
	 * `runner_restart` (#1032): leave so the supervisor starts this runner again on the CLI it has. It
	 * never interrupts an install, and is guarded by the same work look as an update — see
	 * `planRunnerRestart` for why an unanswered look refuses unless forced.
	 */
	const answerRestart = async (body?: unknown): Promise<{ status: number; result: unknown }> => {
		const request = body as { dryRun?: unknown; force?: unknown } | undefined;
		const dryRun = request?.dryRun === true;
		const force = request?.force === true;
		// A forced restart goes past an in-flight install (#1169): the recovery tool must work exactly when something is wedged.
		const blocked = restartBlockedByInstall(bridge.inFlight(), force);
		if (blocked) return { status: 409, result: { error: blocked } };
		const look = force ? null : await boundedWork((signal) => workLook(signal));
		const plan = planRunnerRestart({ current: CLI_VERSION, restarter: restarterFrom(process.env), busy: force ? [] : (look?.busy ?? null), force });
		if (dryRun || plan.action === "refused") return { status: 200, result: { ...plan, dryRun } };
		// Answered before leaving, like an update: the relay sends this reply before timers run.
		setTimeout(() => leaveForRestart(plan.restarter), 25).unref();
		const supervisor = supervisorNote(plan.restarter);
		return { status: 200, result: { action: "restarting", current: plan.current, latest: plan.current, restartedBy: plan.restarter, forced: force, ...(force && bridge.inFlight() ? { interruptedInstall: true } : {}), ...(supervisor ? { supervisor } : {}) } };
	};

	const answerControl = async (path: string, body?: unknown): Promise<{ status: number; result: unknown }> => {
		if (path === RUNNER_UPDATE_PATH) return answerUpdate(body);
		if (path === RUNNER_RESTART_PATH) return answerRestart(body);
		if (path !== MEMBERSHIP_SYNC_PATH) return { status: 404, result: { error: `Unknown runner control ${path}` } };
		const request = body as ReattachRequest | undefined;
		const named = typeof request?.attach === "string" ? request.attach : "";
		const plan = reattachPlan(request, { held: attached.has(named), blocked: blocked.has(named), watching: watchInstances, scope: instanceIds });
		if (plan.refuse) return { status: 409, result: { error: plan.refuse } };
		// A scoped run told the pin moved (#853 finding 13): let go of what is pinned elsewhere now —
		// its socket and, with it, its heartbeat — and attach nothing.
		if (plan.release) {
			const res = await requestPags<{ instances?: DiscoverableInstance[] }>("GET", "/v1/instances/my/instances", { ...opts, pagsToken: pagsToken() });
			const released = pinnedAway(attached.keys(), res.instances ?? [], runnerNode, [...machine.names, machine.id], machine.id);
			for (const id of released) detach(id, `${id.slice(0, 8)}… (pinned to another machine now)`);
			if (released.length && attached.size === 0) writeLine("This `pags up --instance` holds no agent now — close it, or restart it without --instance.");
			return { status: 200, result: { attached: [...attached.keys()], released } };
		}
		// A named agent (#856): let go of whatever this process holds for it, then attach it afresh.
		if (plan.target) {
			if (plan.unblock) blocked.delete(plan.target);
			if (plan.detach) detach(plan.target);
			if (plan.force) forceNext.add(plan.target);
		}
		if (watchInstances) await syncMembership();
		else if (plan.target) {
			await registerRuntime(plan.target);
			attach(plan.target);
		}
		// A forced attach that did not happen (the agent is pinned elsewhere) must not linger.
		if (plan.target && !attached.has(plan.target)) forceNext.delete(plan.target);
		return { status: 200, result: { attached: [...attached.keys()], ...(plan.target ? { target: plan.target, holding: attached.has(plan.target) } : {}) } };
	};

	// Each agent's declared capabilities confine what its socket may reach (#1164, route-policy.ts).
	const routes = new AgentRoutePolicy(() => requestPags<{ instances?: DiscoverableInstance[] }>("GET", "/v1/instances/my/instances", { ...opts, pagsToken: pagsToken() }).then((r) => r.instances));
	await routes.refresh();

	const attach = (id: string, label = `${id.slice(0, 8)}…`) => {
		if (attached.has(id)) return;
		// Each connect mints a fresh instance-scoped relay token using the account
		// session token (resolved above; opts.pagsToken may be unset if it came from
		// the saved session).
		const mintToken = () =>
			requestPags<{ token: string }>("POST", `/v1/relay/${apiPathSegment(id)}/token`, { ...opts, pagsToken: pagsToken() }, {}).then((r) => r.token);
		attached.set(
			id,
			openRelaySocket(
				id,
				apiBase,
				mintToken,
				localUrl,
				runnerToken,
				// `pags up --force` for the whole process, or for this one agent at the cloud's request (#856).
				force || forceNext.delete(id),
				(conflicted) => {
					blocked.add(conflicted);
					attached.delete(conflicted);
				},
				// Registration rides the RECONNECT, which is the whole wake case (#497). The socket
				// retries with backoff; `POST …/runtime` did not, so after a sleep the machine had a
				// live relay and no runtime row — and `resumeSessionsForNode`, which lives inside that
				// route, never ran either, so its own suspended coding sessions stayed suspended. The
				// upsert is idempotent, so re-registering on every reconnect is safe. The first open
				// is skipped when the register already succeeded above (or in the discovery pass),
				// and taken when it did not — which is how a register lost to a boot-time
				// `fetch failed` finally gets a second chance.
				async (openedId, reconnect) => {
					if (reconnect) relayReconnects++;
					if (!shouldRegisterOnOpen(reconnect, registered.has(openedId))) return;
					// A reconnect REFRESHES the row; it does not re-claim. `--force` suspends coding
					// sessions owned by other machines, and that is a one-time act the user asked for
					// at startup — a network blip must not repeat it on every socket that comes back.
					// `resumeSessionsForNode`, the half this machine needs after a wake, runs either
					// way (`routes/instances.ts:365`, outside the force branch).
					await registerRuntime(openedId, reconnect ? false : force);
					reportRegistration();
				},
				answerControl,
				runnerNode,
				// The final automatic-update drain is an admission gate, not merely another poll:
				// command work starts only when the old runner is still permitted to serve it.
				() => relayMutationAdmission.begin(),
				routes.refusalFor(id),
			),
		);
		if (label) writeLine(`Attached agent: ${label}`);
	};

	const detach = (id: string, label = `${id.slice(0, 8)}…`) => {
		const handle = attached.get(id);
		if (!handle) return;
		handle.close();
		attached.delete(id);
		writeLine(`Detached agent: ${label}`);
	};

	for (const id of instanceIds) attach(id, "");

	// Was "Runtime registered with PAGS ✓", printed after the register loop whether or not a
	// single register had succeeded — and the TUI turned that string into the green light (#497).
	reportRegistration();
	const startup = registrationStatus(attached.keys(), registered);
	writeLine(startup.state === "ok"
		? `Runtime registered with PAGS ✓ (${startup.agents} agents)`
		: `Runtime registration incomplete: ${startup.agents} agents — retried on each relay (re)connect${watchInstances ? " and every 20s while this runs" : ""}.`);
	writeLine("");
	writeLine("═══════════════════════════════════════════════");
	writeLine(`  ✅ CONNECTED — WebSocket relay · ${hostname()}`);
	writeLine(`  Agents:   ${instanceIds.length} instance${instanceIds.length === 1 ? "" : "s"}`);
	writeLine("  No cloudflared needed. Ctrl+C to disconnect.");
	writeLine("═══════════════════════════════════════════════");

	// Heartbeat loop — keeps the runtime status "online" in D1.
	// Uses unref'd timers so the loop doesn't prevent process exit.
	//
	// Reported on TRANSITION, not per beat. A silently dropped heartbeat is not a lost metric:
	// this is the only thing that keeps the console's runner badge online, so once it starts
	// failing the console says "runner offline — run `pags up`" while this window still says
	// CONNECTED, with nothing anywhere explaining the contradiction. The documented remedy for
	// that banner is `pags up --force`, which SUSPENDS coding sessions owned by other machines —
	// so the silence steered the user toward a destructive action. Once per state change keeps
	// a 30s loop from becoming a log spammer.
	let heartbeatFailing = false;
	// Post-run cleanup (#1265): the platform's per-machine mode goes down to the local runner on the heartbeat
	// answer; the runner's status (mode, leftovers found, last pass) comes back up on the next heartbeat.
	const cleanupSync = createCleanupSync(localUrl, runnerToken, fetch, writeLine);
	// What this machine can do (#1312): detected once at startup in the background, re-detected every 10 minutes, and
	// sent in full only when the platform does not hold this hash — every other beat carries the hash alone.
	const capabilityReporter = new CapabilityReporter();
	capabilityReporter.refreshIfDue();
	const heartbeat = () => {
		const timer = setTimeout(async () => {
			// The live set, not the startup array — a heartbeat for a detached instance would
			// keep it looking online, and a newly attached one would look offline until restart.
			let failure: string | null = null;
			// One machine reading per beat, sent with every agent's heartbeat (#924): the machine, its
			// checkout volume, this process, one relay round trip, and which session is using what.
			const first = attached.values().next().value as RelaySocketHandle | undefined;
			const [relayRttMs, sessions, runtime] = await Promise.all([first ? first.probeRtt() : Promise.resolve(null), readSessionResources(localUrl, runnerToken), probeRuntimeHealth(localUrl, runnerToken)]);
			const resources = sampleResources(undefined, undefined, {
				disk: sampleDisk() ?? undefined,
				memAvailableBytes: sampleMemAvailable() ?? undefined, // #1275: macOS available memory (free + inactive + purgeable)
				runner: {
					startedAt: processStartedAt,
					uptimeSec: Math.round(process.uptime()),
					starts24h,
					relayReconnects,
					// #896: who is heartbeating. Set by `runner connect` from the lock it took.
					...(process.env.PAGS_RUNNER_RSID ? { rsid: process.env.PAGS_RUNNER_RSID } : {}),
					pid: process.pid,
					...(process.env.PAGS_RUNNER_LAUNCH ? { launch: process.env.PAGS_RUNNER_LAUNCH } : {}),
					supervisor: restartOwner(), // #1154: what starts it again if it dies
					sessionExpiresAt: sessionExpiresAt(pagsToken() ?? "") ?? undefined, // #1157: when this runner signs out
				},
				relayRttMs,
				sessions: sessions ?? undefined,
				runtime, // #1167: the runtime's own /health, so a wedged runtime no longer reads online off the CLI's heartbeat
			});
			const cleanup = await cleanupSync.collect(resources);
			for (const id of [...attached.keys()]) {
				try {
					const sent = cell.next();
					const response = await requestPags<Record<string, unknown>>("POST", `/v1/instances/${apiPathSegment(id)}/runtime/heartbeat`, opts, {
						runnerNode,
						machineId: machine.id,
						resources,
						...capabilityReporter.payload(),
						autoUpdateStatus: autoUpdateStatusBody(),
						...(cleanup.status ? { cleanup: cleanup.status } : {}),
						...(cleanup.doneAt ? { cleanupNowDoneAt: cleanup.doneAt } : {}),
					});
					channel.accept(response, sent);
					capabilityReporter.accept(response);
					await cleanupSync.accept(response);
				} catch (e) {
					failure = e instanceof Error ? e.message : String(e);
				}
			}
			if (failure && !heartbeatFailing) {
				heartbeatFailing = true;
				// The status line is what the pane reads. Before it existed, this message's
				// `fetch failed` was matched as a REGISTRATION failure — so a 30-second heartbeat
				// blip put a permanent ✗ next to "ProAgentStore" for a machine that was fine.
				writeLine(formatStatusLine({ heartbeat: "fail", reason: failure }));
				writeError(`Heartbeat failed: ${failure} — the console will show this machine as OFFLINE until it recovers. The relay itself is still connected; don't run \`pags up --force\` elsewhere.`);
			} else if (!failure && heartbeatFailing) {
				heartbeatFailing = false;
				writeLine(formatStatusLine({ heartbeat: "ok" }));
				writeLine("Heartbeat recovered — this machine reads as online again.");
			}
			heartbeat();
		}, 30_000);
		timer.unref(); // don't keep the process alive just for heartbeats
	};
	heartbeat();

	if (watchInstances) startDiscovery();

	/**
	 * Let go of a conflict that has ended (#497).
	 *
	 * `blocked` had an `add` and no `delete`, which contradicted its own comment ("clearing the
	 * block … lets the next pass attach") and made ONE 4409 permanent for the life of the process.
	 * That is the difference between an agent that comes back on its own and one that comes back
	 * when a human notices and restarts the CLI — and the conflict does end by itself: a holder
	 * that exits takes its socket with it, and an abandoned socket is evicted server-side.
	 *
	 * One cheap status GET per blocked id per pass — not a reconnect. #237 was about a socket
	 * retrying a permanent conflict every 30s and logging it forever; this neither opens a socket
	 * nor logs unless something changed.
	 */
	async function clearFinishedConflicts(): Promise<void> {
		for (const id of [...blocked]) {
			const free = await requestPags<{ connected?: boolean }>(
				"GET",
				relayStatusPath(apiPathSegment(id), runnerNode),
				{ ...opts, pagsToken: pagsToken() },
			).then((r) => r.connected === false).catch(() => false);
			if (!free) continue;
			blocked.delete(id);
			writeLine(`Relay conflict cleared: ${id.slice(0, 8)}… — the other runner is gone; reattaching.`);
		}
	}

	/**
	 * One membership pass: attach what this machine should hold, detach what it should not. The
	 * 20s poll runs it, and so does the cloud on a repin (#850) — one queue, so the two can never
	 * diff the same set at once and attach an agent twice.
	 */
	function syncMembership(): Promise<void> {
		syncing = syncing.catch(() => undefined).then(async () => {
			await clearFinishedConflicts();
			const res = await requestPags<{ instances?: DiscoverableInstance[] }>(
				"GET",
				"/v1/instances/my/instances",
				{ ...opts, pagsToken: pagsToken() },
			);
			routes.learn(res.instances);
			shouldHoldNow = eligibleIds(res.instances ?? [], runnerNode, [...machine.names, machine.id], machine.id);
			const { attach: toAttach, detach: toDetach } = diffMembership(
				attached.keys(),
				res.instances ?? [],
				runnerNode,
				blocked,
				// The names this machine has also worn. Without them a pin made under a
				// previous hostname reads as "pinned to another machine", and this poll
				// detaches the agent twenty seconds after startup attached it (#379). Its id: a pin (#1250).
				[...machine.names, machine.id],
				machine.id,
			);
			for (const inst of toAttach) {
				await registerRuntime(inst.id);
				attach(inst.id, instanceLabel(inst));
			}
			for (const id of toDetach) detach(id);
			// The registration retry nothing else performs (#497). A socket that came up while
			// its `POST …/runtime` failed is the exact state the original report showed — the
			// secure link connected, ProAgentStore "not registered" — and until this, the only
			// thing that could clear it was the socket dropping again, which on a machine that
			// stays awake may never happen. Silent when healthy: an empty list writes nothing.
			const pending = pendingRegistrations(attached.keys(), registered);
			if (pending.length) {
				for (const id of pending) await registerRuntime(id);
				reportRegistration();
			}
		});
		return syncing;
	}

	/**
	 * Poll for membership changes. Deliberately polling, not server push: a brand-new instance
	 * has no socket for the server to push over, so the first version of this cannot be
	 * realtime (#83 tracks the push path). 20s is under the console's own status refresh, so
	 * the panel flips to connected on its own without feeling like a restart.
	 */
	function startDiscovery(): void {
		const tick = () => {
			const timer = setTimeout(async () => {
				try {
					await syncMembership();
				} catch {
					// A failed poll is not worth a log line every 20s — the next one retries, and
					// a genuinely broken session already surfaces on the relay sockets.
				}
				tick();
			}, 20_000);
			timer.unref();
		};
		tick();
	}
}

/** The local runner's per-session CPU/memory (#924), or null when it could not be read this beat. */
async function readSessionResources(localUrl: string, runnerToken: string): Promise<ResourceSample["sessions"] | null> {
	try {
		const res = await fetch(`${localUrl}/coding/resources`, { headers: { Authorization: `Bearer ${runnerToken}` }, signal: AbortSignal.timeout(3000) });
		if (!res.ok) return null;
		const body = (await res.json()) as { sessions?: ResourceSample["sessions"] | null };
		return Array.isArray(body.sessions) ? body.sessions : null;
	} catch {
		// A slow or busy runner skips attribution for this beat; the machine reading still goes.
		return null;
	}
}

export interface RelaySocketHandle {
	/** Stop reconnecting and close the socket. Detaching an instance must not leave a
	 *  reconnect timer alive — it would re-open a socket for an agent we no longer serve. */
	close(): void;
	/**
	 * Round trip of one probe through the relay, ms (#924) — "slow" vs "stuck" for this machine.
	 * Null when the socket is not open or no echo came back in time (a platform before the echo, or
	 * a relay too slow to answer within the timeout — which is itself the reading).
	 */
	probeRtt(timeoutMs?: number): Promise<number | null>;
}

/** How long a relayed command may wait on the local runtime (#1169). Without it one wedged request held a mutation slot — and
 *  so the update drain — forever. Mutable so a test need not wait ten minutes. */
export const relayLimits = { forwardMs: 600_000 };

/** The reason a forward is aborted with when the relay sends `{ type: "cancel", id }` (#1358). */
const CANCELLED_BY_RELAY = "cancelled by the relay";

/** The relay echo protocol (#924): the runner sends `rtt:<id>`, the RelayDO answers `rtt-echo:<id>`. */
export const RTT_PROBE_PREFIX = "rtt:";
export const RTT_ECHO_PREFIX = "rtt-echo:";

/**
 * Half-open detection (#1168). A socket the network dropped silently (NAT timeout, Wi-Fi change) never fires `onclose`, so
 * nothing would ever reconnect it while the heartbeat kept the machine looking fresh. Any inbound frame proves the path is
 * alive; after `idleMs` without one the CLI sends its own echo probe, and no answer within `probeTimeoutMs` means the socket is
 * dead and is replaced. A quiet-but-healthy socket costs one tiny frame per `idleMs`.
 */
export interface RelayLiveness {
	idleMs: number;
	probeTimeoutMs: number;
	checkEveryMs: number;
}
export const DEFAULT_RELAY_LIVENESS: RelayLiveness = { idleMs: 60_000, probeTimeoutMs: 10_000, checkEveryMs: 15_000 };

export function openRelaySocket(
	instanceId: string,
	wsBase: string,
	mintToken: () => Promise<string>,
	localUrl: string,
	runnerToken: string,
	force = false,
	/** Called when the server says another live runner owns this instance (4409). Retrying
	 *  can never succeed while that runner holds it, so the caller stops re-attaching rather
	 *  than turning a permanent conflict into an endless reconnect log (#229). */
	onConflict?: (instanceId: string) => void,
	/** Called on every successful open, with whether this open is a RE-connect. The socket is the
	 *  only thing here that retries, so anything that must survive a wake has to ride it (#497). */
	onOpen?: (instanceId: string, reconnect: boolean) => void | Promise<void>,
	/** Answers a cloud → CLI control command (#850) instead of forwarding it to the local runner. */
	onControl?: (path: string, body?: unknown) => Promise<{ status: number; result: unknown }>,
	/** The node name this socket connects under — the SAME one the process registers and heartbeats
	 *  under (#922). Read once, not per connect: `os.hostname()` moves under a machine (#379), and a
	 *  socket that followed it opened in a relay slot no registration names, so every status read
	 *  probed the registered name, found no socket, and reported a live machine as disconnected while
	 *  its heartbeat kept `lastSeenAt` fresh — and the slot it was in never had its own row stamped. */
	runnerNode: string = hostname(),
	/** Returns a release handle for an admitted mutation, or null while the safe-update drain is
	 * closed. Read-only probes do not participate. */
	beginMutation: () => (() => void) | null = () => () => undefined,
	/**
	 * Why this agent may not reach `method path` on the local runtime, or null (#1164). Asked of every
	 * relayed command before it is forwarded: the socket names the agent, and the agent's declared
	 * capabilities name the routes it needs (`route-policy.ts`). Absent: nothing is refused.
	 */
	routeRefusal: (method: string, path: string, body?: unknown) => string | null = () => null,
	liveness: RelayLiveness = DEFAULT_RELAY_LIVENESS,
): RelaySocketHandle {
	let backoffMs = 1000;
	let reconnecting = false;
	let closed = false;
	let opened = false;
	let socket: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	const rttWaiters = new Map<string, (echoedAt: number) => void>();
	/** The commands being forwarded to the local runtime, by relay command id, so a relay `cancel` can stop the right one (#1358). */
	const inflight = new Map<string, AbortController>();
	let lastInboundAt = Date.now();
	let watchdog: ReturnType<typeof setInterval> | null = null;

	const stopWatchdog = () => {
		if (watchdog) { clearInterval(watchdog); watchdog = null; }
	};

	const scheduleReconnect = (message: string) => {
		reconnecting = true;
		writeLine(`${message} — reconnecting in ${Math.round(backoffMs / 1000)}s`);
		retryTimer = setTimeout(() => {
			reconnecting = false;
			connect();
		}, backoffMs);
		backoffMs = Math.min(backoffMs * 2, 30_000);
	};

	/** One echo probe through `ws`: the round trip in ms, or null when it could not be sent or nothing came back in time. */
	const probe = (ws: WebSocket, timeoutMs: number): Promise<number | null> => {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const sentAt = Date.now();
		return new Promise<number | null>((resolveRtt) => {
			const timer = setTimeout(() => { rttWaiters.delete(id); resolveRtt(null); }, timeoutMs);
			timer.unref?.();
			rttWaiters.set(id, (echoedAt) => { clearTimeout(timer); rttWaiters.delete(id); resolveRtt(echoedAt - sentAt); });
			try { ws.send(`${RTT_PROBE_PREFIX}${id}`); } catch { clearTimeout(timer); rttWaiters.delete(id); resolveRtt(null); }
		});
	};

	/** Drop a socket the network has stopped carrying and open a new one. Its own `onclose` may never fire, so it is detached first. */
	const recycle = (ws: WebSocket, silentMs: number) => {
		stopWatchdog();
		ws.onopen = null;
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;
		try { ws.close(); } catch { /* already gone */ }
		if (socket === ws) socket = null;
		if (closed || reconnecting) return;
		scheduleReconnect(`Relay silent: ${instanceId.slice(0, 8)}… sent nothing for ${Math.round(silentMs / 1000)}s and did not answer a probe (half-open socket)`);
	};

	const startWatchdog = (ws: WebSocket) => {
		stopWatchdog();
		let probing = false;
		watchdog = setInterval(() => {
			if (closed || socket !== ws || probing) return;
			const silentMs = Date.now() - lastInboundAt;
			if (silentMs < liveness.idleMs) return;
			probing = true;
			const startedAt = Date.now();
			void probe(ws, liveness.probeTimeoutMs).then((rtt) => {
				probing = false;
				// Anything that arrived while the probe was out is proof of life, whether or not it was the echo.
				if (closed || socket !== ws || rtt !== null || lastInboundAt >= startedAt) return;
				recycle(ws, Date.now() - lastInboundAt);
			});
		}, liveness.checkEveryMs);
		watchdog.unref?.();
	};

	const connect = async () => {
		if (closed) return;
		// Mint a fresh short-lived, instance-scoped relay token per connect — the
		// long-lived account session token is never placed in the WS URL.
		let relayToken: string;
		try {
			relayToken = await mintToken();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// 402 = the runner is a Pro feature and this account isn't subscribed.
			// Retrying can never succeed — surface the upgrade message and stop
			// (otherwise a free user sits in an infinite mint-retry loop).
			if (/^402\b/.test(msg)) {
				writeLine(`Runner unavailable for ${instanceId.slice(0, 8)}…: ${msg.replace(/^402\s*/, "")}`);
				return;
			}
			const hint = /401|token|sign/i.test(msg) ? " (run `pags login`)" : "";
			writeLine(`Relay token mint failed: ${instanceId.slice(0, 8)}…${hint} — retrying in ${Math.round(backoffMs / 1000)}s`);
			retryTimer = setTimeout(() => { connect(); }, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 30_000);
			return;
		}
		const params = new URLSearchParams({ token: relayToken, node: runnerNode });
		if (force) params.set("force", "1");
		const url = `${wsBase}/v1/relay/${encodeURIComponent(instanceId)}/connect?${params.toString()}`;
		const ws = new WebSocket(url);
		socket = ws;

		ws.onopen = () => {
			backoffMs = 1000;
			const reconnect = opened;
			opened = true;
			lastInboundAt = Date.now();
			startWatchdog(ws);
			writeLine(`Relay connected: ${instanceId.slice(0, 8)}…`);
			// Fire-and-forget: a failing re-registration must not take the socket down with it —
			// it is retried on the next reconnect, and reported through the status line meanwhile.
			void Promise.resolve(onOpen?.(instanceId, reconnect)).catch(() => undefined);
		};

		ws.onmessage = async (event) => {
			lastInboundAt = Date.now();
			const text = typeof event.data === "string" ? event.data : String(event.data);
			// Server pings to verify liveness — respond with pong
			if (text === "ping") { try { ws.send("pong"); } catch { /* closed */ } return; }
			if (text.startsWith(RTT_ECHO_PREFIX)) { rttWaiters.get(text.slice(RTT_ECHO_PREFIX.length))?.(Date.now()); return; }
			let cmd: { type?: string; id: string; method?: string; path: string; body?: unknown };
			try {
				cmd = JSON.parse(text) as { type?: string; id: string; method?: string; path: string; body?: unknown };
			} catch {
				return;
			}
			// The relay has stopped waiting for this command (#1358): stop forwarding it. The relay already told its caller it timed
			// out, so there is no reply to send — only a local request, and the mutation slot it holds, to let go of.
			if (cmd.type === "cancel" && cmd.id) {
				inflight.get(cmd.id)?.abort(new Error(CANCELLED_BY_RELAY));
				return;
			}
			if (!cmd.id || !cmd.path) return;
			if (onControl && CLI_CONTROL_PATHS.has(cmd.path)) {
				// A detach this pass performs may close THIS socket — the reply is then lost, and the
				// cloud reads the socket going away as the answer it is.
				const reply = await onControl(cmd.path, cmd.body).catch((err) => ({ status: 500, result: { error: err instanceof Error ? err.message : String(err) } }));
				try { ws.send(JSON.stringify({ id: cmd.id, ...reply })); } catch { /* closed by the detach */ }
				return;
			}

			// Dispatch to local runner HTTP server
			const method = (cmd.method || "POST").toUpperCase();
			// Only the routes THIS agent's declared capabilities need (#1164) — refused here, before the
			// runtime, so a socket cannot reach another kind of agent's routes on this machine.
			const refused = routeRefusal(method, cmd.path, cmd.body);
			if (refused) {
				try { ws.send(JSON.stringify({ id: cmd.id, status: 403, result: { error: refused } })); } catch { /* WS closed */ }
				return;
			}
			const releaseMutation = method !== "GET" && method !== "HEAD" ? beginMutation() : null;
			if (method !== "GET" && method !== "HEAD" && !releaseMutation) {
				// Do not let a new local/coding request begin between the final idle observation and
				// the supervised restart. The cloud already treats transient runner unavailability as
				// retryable; reporting it explicitly is safer than accepting work we are about to cut off.
				try { ws.send(JSON.stringify({ id: cmd.id, status: 503, result: { error: "Runner is draining for a safe automatic update; retry shortly." } })); } catch { /* WS closed */ }
				return;
			}
			const hasBody = method !== "GET" && method !== "HEAD" && cmd.body !== undefined;
			const controller = new AbortController();
			inflight.set(cmd.id, controller);
			try {
				const headers: Record<string, string> = {};
				if (hasBody) headers["Content-Type"] = "application/json";
				if (runnerToken) headers.Authorization = `Bearer ${runnerToken}`;
				headers["X-PAGS-Instance-Id"] = instanceId;
				// The forward's own limit, and the relay's cancel, both end the same request.
				const timeout = AbortSignal.timeout(relayLimits.forwardMs);
				timeout.addEventListener("abort", () => controller.abort(timeout.reason), { once: true });
				const res = await fetch(`${localUrl}${cmd.path}`, {
					method,
					headers,
					body: hasBody ? JSON.stringify(cmd.body) : undefined,
					signal: controller.signal,
				});
				const text = await res.text().catch(() => "");
				let result: unknown;
				// Marked (#898): a non-JSON reply cut silently read as the runner's whole answer.
				try { result = text ? JSON.parse(text) : {}; } catch { result = text.length > 500 ? { raw: text.slice(0, 500), rawChars: text.length, truncated: true } : { raw: text }; }
				try { ws.send(JSON.stringify({ id: cmd.id, status: res.status, result })); } catch { /* WS closed mid-flight */ }
			} catch (err) {
				// Cancelled by the relay: its caller has already been told, so nothing is sent back.
				if (controller.signal.aborted && (controller.signal.reason as Error | undefined)?.message === CANCELLED_BY_RELAY) return;
				const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
				const error = timedOut ? `The local runtime did not answer within ${Math.round(relayLimits.forwardMs / 1000)}s.` : err instanceof Error ? err.message : String(err);
				try { ws.send(JSON.stringify({ id: cmd.id, status: timedOut ? 504 : 500, error })); } catch { /* WS closed */ }
			} finally {
				inflight.delete(cmd.id);
				releaseMutation?.();
			}
		};

		ws.onclose = (ev) => {
			if (socket === ws) stopWatchdog();
			if (closed || reconnecting) return;
			// Another live runner owns this instance. Reconnecting cannot win it, and doing so
			// every backoff produced an identical line forever; tell the caller so discovery
			// stops re-attaching, and say what actually fixes it.
			if (ev.code === 4409 && !force) {
				writeLine(`Relay conflict: ${instanceId.slice(0, 8)}… is connected on another machine — run \`pags up --force\` here to take it over.`);
				closed = true;
				onConflict?.(instanceId);
				return;
			}
			// Report what the server actually SAID. The old branch tested for 4401/1008 — codes
			// nothing in the codebase ever sends — so every real rejection (409 "another runner",
			// 401 after a key rotation) arrived as a bare 1006 and the message was dropped,
			// leaving the user watching an identical reconnect line forever.
			const said = (ev.reason || "").trim();
			const hint = ev.code === 4401 ? " — run `pags login`, then `pags up`" : ev.code === 4409 ? " — run `pags up --force` to take over" : "";
			const reason = said ? ` (${said}${hint})` : ev.code === 1008 ? " (token expired — run `pags login` then `pags up`)" : "";
			scheduleReconnect(`Relay disconnected: ${instanceId.slice(0, 8)}…${reason}`);
		};

		ws.onerror = () => {
			// onclose will fire after onerror -- reconnect handled there
		};
	};

	connect();

	return {
		close() {
			closed = true;
			stopWatchdog();
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
			try { socket?.close(); } catch { /* already closed */ }
			socket = null;
		},
		probeRtt(timeoutMs = 5000) {
			const ws = socket;
			if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
			return probe(ws, timeoutMs);
		},
	};
}
