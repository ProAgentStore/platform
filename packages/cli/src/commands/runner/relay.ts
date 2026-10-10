import { hostname } from "node:os";
import { type ResourceSample, recordRunnerStart, sampleDisk, sampleResources } from "./resources.js";
import { loadSession } from "../login.js";
import { loadMachineIdentity } from "../../machine.js";
import { writeError, writeLine } from "../../output.js";
import { apiPathSegment, clean, pagsApiBase, requestPags, requestRunner } from "./http.js";
import { CLI_VERSION, runsFromSource } from "./process.js";
import { deferredUpdateLease, deferredUpdateLeaseActive, installVersion, latestPublishedVersion, leaveForRestart, planRunnerUpdate, restarterFrom, RUNNER_UPDATE_PATH, supervisorNote, type DeferredUpdateLease, type UpdatePlan } from "./self-update.js";
import { diffMembership, instanceLabel, pendingRegistrations, pinnedAway, reattachPlan, registrationStatus, shouldRegisterOnOpen, type DiscoverableInstance, type ReattachRequest } from "./membership.js";
import { formatStatusLine } from "./status-line.js";
import type { PagsRequestOptions } from "./types.js";
import { autoUpdatePolicyKey, autoUpdateStatusWire, loadAutoUpdatePolicy, mayAutomaticallyRestart, nextAutoUpdateDelayMs, policyFromResponse, policyScheduleAction, saveAutoUpdatePolicy, type AutoUpdatePolicy, type AutoUpdateStatus } from "./auto-update.js";
import { AutomaticUpdateController, RelayMutationAdmission } from "./auto-update-controller.js";
import { observedRunnerWork } from "./runner-work-observation.js";

/**
 * The one relay command this CLI answers ITSELF rather than forwarding to the local runner (#850):
 * "re-read which agents this machine should hold, now". Sent by the cloud when an agent is repinned,
 * over any socket this process holds — the target machine then attaches the agent in the same call,
 * and a machine it was pinned away from lets go, instead of each waiting for the next 20s poll.
 * The API sends it by this exact string (`workers/api/src/lib/runner-repin.ts`); change both.
 */
export const MEMBERSHIP_SYNC_PATH = "/pags/membership/sync";

/** Every relay command the CLI answers itself rather than forwarding to the local runner. */
const CLI_CONTROL_PATHS = new Set([MEMBERSHIP_SYNC_PATH, RUNNER_UPDATE_PATH]);

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
	const pagsToken = clean(opts.pagsToken) || clean(process.env.PAGS_TOKEN) || clean(loadSession()?.token);
	if (!pagsToken) throw new Error("PAGS token required for WebSocket relay");
	const runnerNode = hostname();
	// The hostname stays the routing key — it names the relay DO — but it is NOT this machine's
	// identity: it moves with the network. The persisted id is what lets the server recognise a
	// renamed machine as the same one, so a pin made under an old name keeps working (#379).
	const machine = loadMachineIdentity(runnerNode);
	// No persisted machine id means no durable physical identity. Failing closed here prevents a
	// cache shared by two ephemeral containers from becoming a policy identity by accident.
	const autoUpdateKey = machine.id ? autoUpdatePolicyKey(machine.id) : "";
	// A cache is an outage aid, never a second authority: every successful registration and beat
	// replaces it with the owner policy that came from the service.
	let autoUpdatePolicy: AutoUpdatePolicy = autoUpdateKey ? (loadAutoUpdatePolicy(autoUpdateKey) ?? { autoUpdate: false }) : { autoUpdate: false };
	// A cache is never authority for an unattended install. It only retains the last status while
	// disconnected; a successful registration/heartbeat must confirm the current cloud switch.
	let autoUpdatePolicyAuthoritative = false;
	let refreshingAutomaticPolicy = false;
	let scheduleAutomaticUpdate: (initial?: boolean, cancel?: boolean) => void = () => undefined;
	const saveAutoUpdateStatus = (status: AutoUpdateStatus, extra: Partial<AutoUpdatePolicy> = {}) => {
		autoUpdatePolicy = {
			...autoUpdatePolicy,
			...extra,
			status,
			lastAttemptAt: new Date().toISOString(),
		};
		if (autoUpdateKey) saveAutoUpdatePolicy(autoUpdateKey, autoUpdatePolicy);
	};
	const acceptAutoUpdatePolicy = (response: unknown) => {
		if (!autoUpdateKey) return;
		const policy = policyFromResponse(response);
		if (!policy) return;
		const action = policyScheduleAction(autoUpdatePolicy, policy, autoUpdatePolicyAuthoritative);
		autoUpdatePolicy = { ...autoUpdatePolicy, ...policy };
		autoUpdatePolicyAuthoritative = true;
		if (autoUpdateKey) saveAutoUpdatePolicy(autoUpdateKey, autoUpdatePolicy);
		// A disable must cancel a deferred automatic install before it reaches npm.  A manual
		// `runner_update` remains explicitly requested and is intentionally not cancelled here.
		if (action === "cancel") {
			scheduleAutomaticUpdate(false, true);
			return;
		}
		if (refreshingAutomaticPolicy) return;
		if (action === "start") {
			scheduleAutomaticUpdate(true);
		}
	};

	// Register the runtime (needed for the status badge / getRunnerConn)
	const capabilities = await requestRunner<{ capabilities?: unknown }>("GET", "/capabilities", { url: localUrl, token: runnerToken, instanceId: instanceIds[0] });
	const caps = Array.isArray(capabilities.capabilities) ? capabilities.capabilities.filter((item): item is string => typeof item === "string") : [];
	// Which instances currently hold a runtime registration from THIS machine. Tracked, not
	// assumed: a register that failed at startup used to be lost forever (nothing retried it),
	// and the pane still printed a tick because the success line was unconditional (#497).
	const registered = new Set<string>();
	let lastRegisterError = "";
	const registerRuntime = async (id: string, forceClaim = force): Promise<boolean> => {
		try {
			const result = await requestPags<Record<string, unknown>>("POST", `/v1/instances/${apiPathSegment(id)}/runtime`, opts, {
				endpointUrl: localUrl,
				token: runnerToken,
				placement: "local",
				capabilities: caps,
				runnerVersion: CLI_VERSION,
				runnerNode,
				machineId: machine.id,
				machineNames: machine.names,
				force: forceClaim,
				autoUpdateStatus: {
					status: autoUpdateStatusWire(autoUpdatePolicy.status),
					latestVersion: autoUpdatePolicy.latestVersion,
					error: autoUpdatePolicy.reason,
				},
			});
			acceptAutoUpdatePolicy(result);
			registered.add(id);
			return true;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			registered.delete(id);
			lastRegisterError = msg;
			writeError(`register ${id.slice(0, 8)}… failed: ${msg}`);
			return false;
		}
	};
	/** A cached policy is only a display hint. Every unattended check re-registers one held agent
	 * to obtain a fresh owner decision; a network/API failure therefore defers rather than installs. */
	const refreshAutomaticPolicy = async (): Promise<boolean> => {
		const id = registered.values().next().value as string | undefined;
		if (!id) return false;
		autoUpdatePolicyAuthoritative = false;
		refreshingAutomaticPolicy = true;
		try {
			return await registerRuntime(id) && autoUpdatePolicyAuthoritative;
		} finally {
			refreshingAutomaticPolicy = false;
		}
	};
	// The live membership set. A captured array is what made a newly subscribed agent
	// unreachable until restart (#229); sockets are now added and removed while running.
	const attached = new Map<string, RelaySocketHandle>();
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
	const updateFacts = async () => {
		const [sessionsResult, healthResult] = await Promise.allSettled([
			requestRunner<{ sessions?: Array<{ sessionId: string; alive?: boolean; runState?: string }> }>("GET", "/coding/sessions", {
			url: localUrl,
			token: runnerToken,
			instanceId: instanceIds[0],
			}),
			requestRunner<{ work?: { codingTurns?: number; localRuns?: number; detail?: string[] } }>("GET", "/health", { url: localUrl, token: runnerToken, instanceId: instanceIds[0] }),
		]);
		// An unavailable observation is NEVER evidence that a restart is safe. A local browser/apply
		// run can be destroyed by a restart just as surely as a coding turn, so fail closed.
		const busy = sessionsResult.status === "fulfilled" && healthResult.status === "fulfilled"
			? observedRunnerWork({ sessions: sessionsResult.value.sessions, work: healthResult.value.work })
			: ["runner-work-observation-unavailable"];
		return {
			current: CLI_VERSION,
			latest: await latestPublishedVersion(),
			fromSource: runsFromSource(),
			restarter: restarterFrom(process.env),
			// A restart ends browser/application work too. Give these durable names to the same
			// planner so neither manual nor automatic update can mistake them for an idle machine.
			busy,
		};
	};
	/**
	 * Install the release, then leave so whatever supervises this process starts it again (#860) — see
	 * `leaveForRestart`. Sockets close first, cleanly.
	 */
	let updateInstallInFlight = false;
	let installedPendingRestart: string | null = null;
	// Once an unattended install has finished, no new mutating relay command is admitted while we
	// observe the runner one final time. This turns "idle at the last poll" into a real admission
	// boundary: a coding turn cannot slip in during npm or the old 500ms restart delay.
	const relayMutationAdmission = new RelayMutationAdmission();
	const installAndRestart = async (plan: Extract<UpdatePlan, { action: "update" }>, automatic = false, lease?: DeferredUpdateLease): Promise<boolean> => {
		// An automatic check and a remote manual request may both have observed the same old version.
		// Only one may ever reach npm/restart; a second observer leaves the first to finish.
		if (updateInstallInFlight || (lease && !deferredUpdateLeaseActive(lease))) return false;
		updateInstallInFlight = true;
		// Cached policy is deliberately insufficient for unattended mutation. Read the owner's
		// current switch immediately before npm so an offline runner cannot install after a disable.
		if (automatic && (!(await refreshAutomaticPolicy()) || !autoUpdatePolicy.autoUpdate)) {
			updateInstallInFlight = false;
			return false;
		}
		if (installedPendingRestart !== plan.latest) {
			writeLine(`Updating ${plan.current} → ${plan.latest} (runner_update)…`);
			try {
				await installVersion(plan.latest);
				installedPendingRestart = plan.latest;
			} catch (error) {
				updateInstallInFlight = false;
				throw error;
			}
		}
		// Npm may run for minutes. Block new work, then re-admit restart after it finishes, rather
		// than trusting the idle snapshot that admitted installation; a run that began during npm
		// must survive. The short drain also lets a request admitted just before the boundary show up
		// in /health before we make the final decision.
		await relayMutationAdmission.drain();
		await new Promise<void>((resolve) => setTimeout(resolve, 500));
		if (lease && !deferredUpdateLeaseActive(lease)) {
			relayMutationAdmission.resume();
			updateInstallInFlight = false;
			return false;
		}
		if (automatic) {
			if (!(await refreshAutomaticPolicy()) || !autoUpdatePolicy.autoUpdate) {
				relayMutationAdmission.resume();
				updateInstallInFlight = false;
				return false;
			}
		}
		const finalFacts = await updateFacts();
		if (finalFacts.busy.length || (automatic && !mayAutomaticallyRestart({ authoritative: autoUpdatePolicyAuthoritative, enabled: autoUpdatePolicy.autoUpdate, workObserved: !finalFacts.busy.includes("runner-work-observation-unavailable"), busy: finalFacts.busy }))) {
			relayMutationAdmission.resume();
			updateInstallInFlight = false;
			return false;
		}
		writeLine(`Installed ${plan.latest} — restarting; every agent re-attaches on the way back up.`);
		for (const id of [...attached.keys()]) detach(id);
		// The control reply must leave the relay before `process.exit` closes its socket.  The caller
		// owns the actual exit: an explicit update schedules it after its acknowledgement, while a
		// deferred or unattended update has no reply to wait for (#1008).
		return true;
	};
	/** A deferred update waits for busy engines to finish, re-checking — never cuts a turn off (#859). */
	let updateWaiting = false;
	let deferredManualLease: DeferredUpdateLease | null = null;
	const updateWhenIdle = (automatic = false, lease?: DeferredUpdateLease): boolean => {
		if (updateWaiting || (!automatic && !lease)) return false;
		updateWaiting = true;
		if (!automatic) deferredManualLease = lease!;
		const until = automatic ? Date.now() + 60 * 60_000 : lease!.expiresAt;
		const tick = () =>
			setTimeout(async () => {
				if (!automatic && (!deferredManualLease || !deferredUpdateLeaseActive(deferredManualLease))) {
					writeLine("runner_update: the deferred operation lease expired; no delayed restart was performed.");
					deferredManualLease = null;
					updateWaiting = false;
					return;
				}
				// The policy can change while a coding turn runs. Read our most recently synced value
				// and then fetch the owner switch again immediately before planning/installation. It
				// never affects an operator's explicit runner_update command.
				if (automatic && (!(await refreshAutomaticPolicy()) || !autoUpdatePolicy.autoUpdate)) {
					saveAutoUpdateStatus("offline", { reason: "The owner policy could not be refreshed; automatic update is deferred." });
					updateWaiting = false;
					return;
				}
				const plan = planRunnerUpdate(await updateFacts());
				if (plan.action === "update") {
					if (automatic && !autoUpdatePolicy.autoUpdate) {
						updateWaiting = false;
						return;
					}
					if (automatic) saveAutoUpdateStatus("running", { latestVersion: plan.latest, reason: undefined });
					const installed = await installAndRestart(plan, automatic, automatic ? undefined : deferredManualLease ?? undefined).catch((e) => {
						if (automatic) saveAutoUpdateStatus("failure", { reason: e instanceof Error ? e.message : String(e) });
						writeError(`runner_update: install failed — ${e instanceof Error ? e.message : String(e)}`);
						return false;
					});
					if (!installed && Date.now() < until) {
						saveAutoUpdateStatus("waiting-for-idle", { latestVersion: plan.latest });
						tick();
					} else {
						deferredManualLease = null;
						updateWaiting = false;
						if (installed) leaveForRestart(plan.restarter);
					}
				} else if (plan.action === "wait" && Date.now() < until) {
					if (automatic) saveAutoUpdateStatus("waiting-for-idle", { latestVersion: plan.latest, reason: undefined });
					tick();
				} else {
					if (automatic && plan.action === "refused") saveAutoUpdateStatus("unsupported", { reason: plan.reason });
					deferredManualLease = null;
					updateWaiting = false;
				}
			}, 15_000).unref();
		tick();
		return true;
	};

	/**
	 * Poll npm only a few times a day after success, and use an exponential, jittered delay when it
	 * cannot be reached.  This is deliberately separate from the 30-second heartbeat: registry
	 * trouble must not become a request storm, and one automatic run is single-flight with a
	 * deferred idle wait.
	 */
	let automaticTimer: ReturnType<typeof setTimeout> | null = null;
	let automaticChecking = false;
	let automaticFailures = 0;
	const runAutomaticUpdateCheck = async () => {
		if (!autoUpdatePolicy.autoUpdate || !autoUpdatePolicyAuthoritative || automaticChecking || updateWaiting) return;
		automaticChecking = true;
		try {
			if (!(await refreshAutomaticPolicy()) || !autoUpdatePolicy.autoUpdate) {
				saveAutoUpdateStatus("offline", { reason: "The owner policy could not be refreshed; automatic update is deferred." });
				scheduleAutomaticUpdate();
				return;
			}
			saveAutoUpdateStatus("checking", { reason: undefined });
			const facts = await updateFacts();
			// A heartbeat/register response may have disabled updates while npm was answering.
			if (!autoUpdatePolicy.autoUpdate || !autoUpdatePolicyAuthoritative) return;
			if (!facts.latest) {
				automaticFailures++;
				saveAutoUpdateStatus("failure", { reason: "Could not check the trusted npm registry for a newer CLI release." });
				scheduleAutomaticUpdate();
				return;
			}
			automaticFailures = 0;
			const plan = planRunnerUpdate(facts);
			if (plan.action === "up-to-date") {
				saveAutoUpdateStatus("verified-success", { latestVersion: facts.latest, reason: undefined });
				scheduleAutomaticUpdate();
				return;
			}
			if (plan.action === "refused") {
				saveAutoUpdateStatus("unsupported", { latestVersion: facts.latest, reason: plan.reason });
				scheduleAutomaticUpdate();
				return;
			}
			if (plan.action === "wait") {
				saveAutoUpdateStatus("waiting-for-idle", { latestVersion: plan.latest, reason: undefined });
				updateWhenIdle(true);
				return;
			}
			// Re-check the policy at the final possible point.  This shares the existing safe
			// installer/restart path and therefore never duplicates the manual update mechanism.
			if (!autoUpdatePolicy.autoUpdate || !autoUpdatePolicyAuthoritative) return;
			saveAutoUpdateStatus("running", { latestVersion: plan.latest, reason: undefined });
			try {
				const installed = await installAndRestart(plan, true);
				if (!installed) {
					saveAutoUpdateStatus("waiting-for-idle", { latestVersion: plan.latest });
					updateWhenIdle(true);
					return;
				}
				saveAutoUpdateStatus("restarting", { latestVersion: plan.latest, reason: undefined });
			} catch (e) {
				automaticFailures++;
				saveAutoUpdateStatus("failure", { latestVersion: plan.latest, reason: e instanceof Error ? e.message : String(e) });
				scheduleAutomaticUpdate();
			}
		} finally {
			automaticChecking = false;
		}
	};
	scheduleAutomaticUpdate = (initial = false, cancel = false) => {
		if (cancel || !autoUpdatePolicy.autoUpdate || !autoUpdatePolicyAuthoritative) {
			if (automaticTimer) clearTimeout(automaticTimer);
			automaticTimer = null;
			return;
		}
		// Heartbeats are not scheduling events. Preserve a due timer, otherwise 30-second policy
		// read-backs continually replace a six-hour delay and automatic update never checks.
		if (automaticTimer || updateWaiting) return;
		const delay = initial
			? Math.round((5_000 + Math.random() * 25_000))
			: nextAutoUpdateDelayMs(automaticFailures);
		automaticTimer = setTimeout(() => { automaticTimer = null; void runAutomaticUpdateCheck(); }, delay);
		automaticTimer.unref();
	};
	// Never start unattended work from cache alone. A registration/heartbeat response above sets
	// authority and schedules the first jittered check; offline policy fetch failure therefore defers.
	const automaticUpdateController = new AutomaticUpdateController({
		policy: () => ({ value: autoUpdatePolicy, authoritative: autoUpdatePolicyAuthoritative }),
		refreshPolicy: refreshAutomaticPolicy,
		facts: updateFacts,
		plan: planRunnerUpdate,
		// This bridge is deliberately the same function used by explicit runner_update. It owns npm,
		// a fresh authoritative policy, the mutation drain, final local-work observation and restart.
		installAndRestart: async (plan, automatic) => {
			const installed = await installAndRestart(plan, automatic);
			// The controller records its `restarting` status in the microtask after this resolves;
			// leaving on a timer preserves that evidence before the process goes away.
			if (installed) setTimeout(() => leaveForRestart(plan.restarter), 0).unref();
			return installed;
		},
		status: saveAutoUpdateStatus,
	});
	// `acceptAutoUpdatePolicy` is declared before this controller so startup registration can parse
	// the response. From here every heartbeat transition drives the real controller timer.
	scheduleAutomaticUpdate = (initial = false, cancel = false) => automaticUpdateController.onPolicy(cancel ? "cancel" : initial ? "start" : "keep");
	if (autoUpdatePolicyAuthoritative && autoUpdatePolicy.autoUpdate) scheduleAutomaticUpdate(true);
	const answerUpdate = async (body?: unknown): Promise<{ status: number; result: unknown }> => {
		const dryRun = (body as { dryRun?: unknown } | undefined)?.dryRun === true;
		const plan = planRunnerUpdate(await updateFacts());
		if (dryRun || plan.action === "up-to-date" || plan.action === "refused") return { status: 200, result: { ...plan, dryRun } };
		if (plan.action === "wait") {
			const lease = deferredUpdateLease(body);
			if (!lease) return { status: 400, result: { error: "A busy runner_update needs a current operation lease; no delayed restart was scheduled." } };
			if (!updateWhenIdle(false, lease)) return { status: 409, result: { error: "A runner update is already waiting for active work to finish." } };
			return { status: 200, result: { ...plan, operationId: lease.operationId, deferredUntil: lease.expiresAt, detail: "This operation may restart only before its recorded lease expires; no delayed restart survives an expired or terminal operation." } };
		}
		try {
			if (!(await installAndRestart(plan))) return { status: 409, result: { error: "A runner update is already installing or restarting." } };
		} catch (e) {
			return { status: 500, result: { error: `npm could not install ${plan.latest}: ${e instanceof Error ? e.message : String(e)}` } };
		}
		const supervisor = supervisorNote(plan.restarter);
		// `openRelaySocket` sends this value before timers run.  Calling `leaveForRestart` above
		// would synchronously exit and make this decisive machine acknowledgement impossible.
		setTimeout(() => leaveForRestart(plan.restarter), 25).unref();
		return { status: 200, result: { action: "restarting", current: plan.current, latest: plan.latest, restartedBy: plan.restarter, ...(supervisor ? { supervisor } : {}) } };
	};

	const answerControl = async (path: string, body?: unknown): Promise<{ status: number; result: unknown }> => {
		if (path === RUNNER_UPDATE_PATH) return answerUpdate(body);
		if (path !== MEMBERSHIP_SYNC_PATH) return { status: 404, result: { error: `Unknown runner control ${path}` } };
		const request = body as ReattachRequest | undefined;
		const named = typeof request?.attach === "string" ? request.attach : "";
		const plan = reattachPlan(request, { held: attached.has(named), blocked: blocked.has(named), watching: watchInstances, scope: instanceIds });
		if (plan.refuse) return { status: 409, result: { error: plan.refuse } };
		// A scoped run told the pin moved (#853 finding 13): let go of what is pinned elsewhere now —
		// its socket and, with it, its heartbeat — and attach nothing.
		if (plan.release) {
			const res = await requestPags<{ instances?: DiscoverableInstance[] }>("GET", "/v1/instances/my/instances", { ...opts, pagsToken });
			const released = pinnedAway(attached.keys(), res.instances ?? [], runnerNode, machine.names);
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

	const attach = (id: string, label = `${id.slice(0, 8)}…`) => {
		if (attached.has(id)) return;
		// Each connect mints a fresh instance-scoped relay token using the account
		// session token (resolved above; opts.pagsToken may be unset if it came from
		// the saved session).
		const mintToken = () =>
			requestPags<{ token: string }>("POST", `/v1/relay/${apiPathSegment(id)}/token`, { ...opts, pagsToken }, {}).then((r) => r.token);
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
	const heartbeat = () => {
		const timer = setTimeout(async () => {
			// The live set, not the startup array — a heartbeat for a detached instance would
			// keep it looking online, and a newly attached one would look offline until restart.
			let failure: string | null = null;
			// One machine reading per beat, sent with every agent's heartbeat (#924): the machine, its
			// checkout volume, this process, one relay round trip, and which session is using what.
			const first = attached.values().next().value as RelaySocketHandle | undefined;
			const [relayRttMs, sessions] = await Promise.all([first ? first.probeRtt() : Promise.resolve(null), readSessionResources(localUrl, runnerToken)]);
			const resources = sampleResources(undefined, undefined, {
				disk: sampleDisk() ?? undefined,
				runner: {
					startedAt: processStartedAt,
					uptimeSec: Math.round(process.uptime()),
					starts24h,
					relayReconnects,
					// #896: who is heartbeating. Set by `runner connect` from the lock it took.
					...(process.env.PAGS_RUNNER_RSID ? { rsid: process.env.PAGS_RUNNER_RSID } : {}),
					pid: process.pid,
					...(process.env.PAGS_RUNNER_LAUNCH ? { launch: process.env.PAGS_RUNNER_LAUNCH } : {}),
				},
				relayRttMs,
				sessions: sessions ?? undefined,
			});
			for (const id of [...attached.keys()]) {
				try {
					const response = await requestPags<Record<string, unknown>>("POST", `/v1/instances/${apiPathSegment(id)}/runtime/heartbeat`, opts, {
						runnerNode,
						machineId: machine.id,
						resources,
						autoUpdateStatus: {
							status: autoUpdateStatusWire(autoUpdatePolicy.status),
							latestVersion: autoUpdatePolicy.latestVersion,
							error: autoUpdatePolicy.reason,
						},
					});
					acceptAutoUpdatePolicy(response);
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
				`/v1/relay/${apiPathSegment(id)}/status`,
				{ ...opts, pagsToken },
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
				{ ...opts, pagsToken },
			);
			const { attach: toAttach, detach: toDetach } = diffMembership(
				attached.keys(),
				res.instances ?? [],
				runnerNode,
				blocked,
				// The names this machine has also worn. Without them a pin made under a
				// previous hostname reads as "pinned to another machine", and this poll
				// detaches the agent twenty seconds after startup attached it (#379).
				machine.names,
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

/** The relay echo protocol (#924): the runner sends `rtt:<id>`, the RelayDO answers `rtt-echo:<id>`. */
export const RTT_PROBE_PREFIX = "rtt:";
export const RTT_ECHO_PREFIX = "rtt-echo:";

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
): RelaySocketHandle {
	let backoffMs = 1000;
	let reconnecting = false;
	let closed = false;
	let opened = false;
	let socket: WebSocket | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	const rttWaiters = new Map<string, (echoedAt: number) => void>();

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
			writeLine(`Relay connected: ${instanceId.slice(0, 8)}…`);
			// Fire-and-forget: a failing re-registration must not take the socket down with it —
			// it is retried on the next reconnect, and reported through the status line meanwhile.
			void Promise.resolve(onOpen?.(instanceId, reconnect)).catch(() => undefined);
		};

		ws.onmessage = async (event) => {
			const text = typeof event.data === "string" ? event.data : String(event.data);
			// Server pings to verify liveness — respond with pong
			if (text === "ping") { try { ws.send("pong"); } catch { /* closed */ } return; }
			if (text.startsWith(RTT_ECHO_PREFIX)) { rttWaiters.get(text.slice(RTT_ECHO_PREFIX.length))?.(Date.now()); return; }
			let cmd: { id: string; method?: string; path: string; body?: unknown };
			try {
				cmd = JSON.parse(text) as { id: string; method?: string; path: string; body?: unknown };
			} catch {
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
			const releaseMutation = method !== "GET" && method !== "HEAD" ? beginMutation() : null;
			if (method !== "GET" && method !== "HEAD" && !releaseMutation) {
				// Do not let a new local/coding request begin between the final idle observation and
				// the supervised restart. The cloud already treats transient runner unavailability as
				// retryable; reporting it explicitly is safer than accepting work we are about to cut off.
				try { ws.send(JSON.stringify({ id: cmd.id, status: 503, result: { error: "Runner is draining for a safe automatic update; retry shortly." } })); } catch { /* WS closed */ }
				return;
			}
			const hasBody = method !== "GET" && method !== "HEAD" && cmd.body !== undefined;
			try {
				const headers: Record<string, string> = {};
				if (hasBody) headers["Content-Type"] = "application/json";
				if (runnerToken) headers.Authorization = `Bearer ${runnerToken}`;
				headers["X-PAGS-Instance-Id"] = instanceId;
				const res = await fetch(`${localUrl}${cmd.path}`, {
					method,
					headers,
					body: hasBody ? JSON.stringify(cmd.body) : undefined,
				});
				const text = await res.text().catch(() => "");
				let result: unknown;
				// Marked (#898): a non-JSON reply cut silently read as the runner's whole answer.
				try { result = text ? JSON.parse(text) : {}; } catch { result = text.length > 500 ? { raw: text.slice(0, 500), rawChars: text.length, truncated: true } : { raw: text }; }
				try { ws.send(JSON.stringify({ id: cmd.id, status: res.status, result })); } catch { /* WS closed mid-flight */ }
			} catch (err) {
				try { ws.send(JSON.stringify({ id: cmd.id, status: 500, error: err instanceof Error ? err.message : String(err) })); } catch { /* WS closed */ }
			} finally { releaseMutation?.(); }
		};

		ws.onclose = (ev) => {
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
			reconnecting = true;
			// Report what the server actually SAID. The old branch tested for 4401/1008 — codes
			// nothing in the codebase ever sends — so every real rejection (409 "another runner",
			// 401 after a key rotation) arrived as a bare 1006 and the message was dropped,
			// leaving the user watching an identical reconnect line forever.
			const said = (ev.reason || "").trim();
			const hint = ev.code === 4401 ? " — run `pags login`, then `pags up`" : ev.code === 4409 ? " — run `pags up --force` to take over" : "";
			const reason = said ? ` (${said}${hint})` : ev.code === 1008 ? " (token expired — run `pags login` then `pags up`)" : "";
			writeLine(`Relay disconnected: ${instanceId.slice(0, 8)}…${reason} — reconnecting in ${Math.round(backoffMs / 1000)}s`);
			retryTimer = setTimeout(() => {
				reconnecting = false;
				connect();
			}, backoffMs);
			backoffMs = Math.min(backoffMs * 2, 30_000);
		};

		ws.onerror = () => {
			// onclose will fire after onerror -- reconnect handled there
		};
	};

	connect();

	return {
		close() {
			closed = true;
			if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
			try { socket?.close(); } catch { /* already closed */ }
			socket = null;
		},
		probeRtt(timeoutMs = 5000) {
			const ws = socket;
			if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const sentAt = Date.now();
			return new Promise<number | null>((resolveRtt) => {
				const timer = setTimeout(() => { rttWaiters.delete(id); resolveRtt(null); }, timeoutMs);
				timer.unref?.();
				rttWaiters.set(id, (echoedAt) => { clearTimeout(timer); rttWaiters.delete(id); resolveRtt(echoedAt - sentAt); });
				try { ws.send(`${RTT_PROBE_PREFIX}${id}`); } catch { clearTimeout(timer); rttWaiters.delete(id); resolveRtt(null); }
			});
		},
	};
}
