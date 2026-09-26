/**
 * The opt-in ticket queue (#864, #757 slice 3) — autonomous pickup of first-class tickets.
 *
 * A ticket (#757 slices 1-2, `lib/tickets.ts`) sits on the board until something works it. This is
 * the something: a per-minute sweep that, for an instance whose owner turned the queue on, takes the
 * oldest ticket a person has released for autonomous pickup and starts a run for it.
 *
 * Every gate here is a refusal-by-default, because this is the one path that starts work with nobody
 * present:
 *
 *   1. OPT-IN per instance (`ticket_queues.enabled`, #757 §7). No row is off; nothing enables it.
 *   2. AUTHORITY per ticket (`tickets.pickup_authority`, #757 §3). `human` — every existing ticket and
 *      every new one, including an agent's own `create_ticket` — is never picked. Only a person, over
 *      an owner-scoped route, can set `agent`: an agent must not be able to release work to itself.
 *   3. A QUEUE-RUNNABLE status set of its own (#757 §5), which EXCLUDES `needs_human` and `blocked`.
 *      `RUNNABLE_STATUSES` in `actionable-ticket.ts` includes both, because a human approving IS the
 *      unblocking act — and the queue is not a human. It excludes `failed` too: a retry is a decision
 *      a person makes (by re-queueing), not a loop the platform runs on its own.
 *   4. YIELD TO A RED DEPLOY (#757 §6): if the instance's deploy repo, or a repo its runs would drive,
 *      has a failed build on its default branch, nothing new starts on top of a tree nobody can verify.
 *   5. ONE RUN AT A TIME per instance, and ONE ACTIVE SESSION PER REPO through the existing session
 *      APIs (#757 §6): the run is started by `loopDriverFor(caps).start`, the same door `start_work`,
 *      the Loop button and the objective queue use, so a coding instance goes through
 *      `ensureActiveSession` → `getActiveSessionForRepo`/`createSession`'s race handling and
 *      `claimSessionDriver` — never around them. A `busy` answer gives the ticket back.
 *   6. EVERY INSTANCE TYPE (#757 §2): `loopDriverFor` picks the Pilot for a coder and the generic
 *      chat loop for everything else — cloud-only, pipeline and apply agents alike.
 *
 * The run carries `ticketId` in its runtime-task row (`type: "ticket.run"`), which is how the board
 * already attaches a run to its ticket; `run-events.ts` settles that row's status when the run ends.
 */
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { sanitizeMaxIterations } from "./agent-loop.js";
import { buildInstanceBoard } from "./board.js";
import type { BuildRun } from "./build-history.js";
import { listRepos } from "./coding-store.js";
import { openBudget, resolveAccountCeilings } from "./delegation-budget-store.js";
import { logError } from "./error-log.js";
import { listHostedBuilds, type HostedRepoRef } from "./hosted-repo.js";
import { readInstanceConfigPair } from "./instance-config.js";
import { type LoopStartInput, type LoopStartResult, loopDriverFor } from "./loop-drivers.js";
import { clampIterations } from "./loop-limits.js";
import { readLoopLimits } from "./loop-limits-store.js";
import { attachTicketRuns } from "./tickets.js";
import { mirrorRuntimeTask } from "../routes/instances-runtime.js";
import type { Env } from "../types.js";

/**
 * The card statuses the queue may start. `needs_human` and `blocked` are deliberately absent — they
 * mean a person is the blocker — and so is `failed`. Compare `RUNNABLE_STATUSES` (what a HUMAN may
 * approve), which includes all three; reusing it here is the mistake #757 §5 names.
 */
export const QUEUE_RUNNABLE_STATUSES: readonly string[] = ["queued", "needs_approval"];

export function isQueueRunnable(status: unknown): boolean {
	return typeof status === "string" && QUEUE_RUNNABLE_STATUSES.includes(status);
}

export type TicketAuthority = "human" | "agent";

/** A claimed ticket whose run never came back to record itself is re-offered after this. */
const LEASE_MS = 2 * 60_000;
const MAX_OBJECTIVE = 2000;

// ── Deploy gate ──────────────────────────────────────────────────────────────────────────────────

/** A completed build that is evidence (same set `deploy-watch.ts` reports on — `cancelled` is not). */
const EVIDENCE = new Set(["success", "failure", "timed_out", "action_required", "startup_failure"]);

/**
 * Is the newest COMPLETED build on the default branch red? Pure.
 *
 * Only the default branch counts: a failing PR branch says nothing about `main`, and the newest run
 * overall is often a PR's. `branch` null accepts `main` or `master`. An in-progress or cancelled run
 * is skipped rather than read as green or red. No evidence at all is NOT red: the gate is for a
 * known-broken tree, and a repo whose builds cannot be read must not stall every queue forever.
 */
export function redDefaultBranchBuild(runs: readonly BuildRun[], branch: string | null): BuildRun | null {
	const onDefault = (b: unknown) => (branch ? b === branch : b === "main" || b === "master");
	const latest = runs.find((r) => onDefault(r.branch) && r.status === "completed" && EVIDENCE.has(String(r.conclusion ?? "")));
	return latest && latest.conclusion !== "success" ? latest : null;
}

/** The repos a queued run on this instance would stand on: its deploy repo and its coding repos. */
async function reposUnderTheQueue(env: Env, instanceId: string, userId: string): Promise<Array<{ ref: HostedRepoRef; branch: string | null; label: string }>> {
	const out: Array<{ ref: HostedRepoRef; branch: string | null; label: string }> = [];
	const pair = await readInstanceConfigPair(env, instanceId, userId).catch(() => null);
	const deployRepo = typeof pair?.config.githubRepo === "string" ? pair.config.githubRepo : null;
	if (deployRepo) out.push({ ref: { provider: "github", githubRepo: deployRepo, repoSlug: deployRepo }, branch: null, label: deployRepo });
	for (const r of await listRepos(env, instanceId, userId).catch(() => [])) {
		const slug = r.repoSlug || r.githubRepo;
		if (!slug || out.some((o) => o.label === slug)) continue;
		out.push({ ref: { provider: r.provider, githubRepo: r.githubRepo, repoSlug: r.repoSlug }, branch: r.branch || null, label: slug });
	}
	return out.slice(0, 4);
}

export async function redDeployBlocking(env: Env, instanceId: string, userId: string): Promise<string | null> {
	for (const repo of await reposUnderTheQueue(env, instanceId, userId)) {
		const runs = await listHostedBuilds(env, userId, repo.ref, { page: 1, perPage: 20 }).catch(() => null);
		const red = runs ? redDefaultBranchBuild(runs, repo.branch) : null;
		if (red) return `${repo.label}'s default branch is red (${String(red.name || "build")} ${String(red.conclusion)}) — the queue waits for it to go green before starting new work.`;
	}
	return null;
}

// ── Owner controls ───────────────────────────────────────────────────────────────────────────────

export async function ticketQueueEnabled(env: Env, instanceId: string, userId: string): Promise<boolean> {
	const row = await env.DB.prepare("SELECT enabled FROM ticket_queues WHERE instance_id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ enabled: number }>();
	return row?.enabled === 1;
}

/** Turn the queue on or off for an instance. The caller has already proved ownership. */
export async function setTicketQueueEnabled(env: Env, instanceId: string, userId: string, enabled: boolean): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO ticket_queues (instance_id, user_id, enabled, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
		 ON CONFLICT(instance_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
		 WHERE ticket_queues.user_id = excluded.user_id`,
	)
		.bind(instanceId, userId, enabled ? 1 : 0)
		.run();
}

export interface TicketQueueState {
	authority: TicketAuthority;
	pickedAt: string | null;
	runId: string | null;
	note: string | null;
}

export async function ticketQueueState(env: Env, instanceId: string, userId: string, ticketId: string): Promise<TicketQueueState | null> {
	const row = await env.DB.prepare(
		"SELECT pickup_authority, queue_picked_at, queue_run_id, queue_note FROM tickets WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3",
	)
		.bind(ticketId, instanceId, userId)
		.first<{ pickup_authority: TicketAuthority; queue_picked_at: string | null; queue_run_id: string | null; queue_note: string | null }>();
	return row ? { authority: row.pickup_authority, pickedAt: row.queue_picked_at, runId: row.queue_run_id, note: row.queue_note } : null;
}

/**
 * A PERSON sets a ticket's authority — the only way a ticket becomes pickable. `requeue` also clears
 * an earlier pickup, which is how a ticket whose run failed or parked is offered to the queue again.
 * Returns false when the ticket is not this owner's on this instance.
 */
export async function setTicketAuthority(env: Env, instanceId: string, userId: string, ticketId: string, authority: TicketAuthority, requeue = false): Promise<boolean> {
	const res = await env.DB.prepare(
		`UPDATE tickets SET pickup_authority = ?4, updated_at = datetime('now')
		   ${requeue ? ", queue_picked_at = NULL, queue_run_id = NULL, queue_note = NULL" : ""}
		 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3`,
	)
		.bind(ticketId, instanceId, userId, authority)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

// ── Pickup ───────────────────────────────────────────────────────────────────────────────────────

export type PickupResult =
	| { started: true; ticketId: string; runId: string; driver: string }
	| { started: false; reason: "disabled" | "leased" | "busy" | "none" | "deploy_red" | "raced" | "budget" | "driver_busy" | "refused"; ticketId?: string; detail?: string };

/** The seam tests use to observe the start without spawning a Workflow. Defaults to the real driver. */
export interface PickupDeps {
	start?: (input: LoopStartInput) => Promise<LoopStartResult>;
	redDeploy?: (env: Env, instanceId: string, userId: string) => Promise<string | null>;
}

async function takeLease(env: Env, instanceId: string, userId: string, holder: string): Promise<boolean> {
	const now = Date.now();
	const res = await env.DB.prepare(
		`UPDATE ticket_queues SET lease_holder = ?3, lease_until = ?4
		  WHERE instance_id = ?1 AND user_id = ?2 AND enabled = 1 AND (lease_until IS NULL OR lease_until < ?5)`,
	)
		.bind(instanceId, userId, holder, now + LEASE_MS, now)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

async function dropLease(env: Env, instanceId: string, holder: string): Promise<void> {
	await env.DB.prepare("UPDATE ticket_queues SET lease_holder = NULL, lease_until = NULL WHERE instance_id = ?1 AND lease_holder = ?2")
		.bind(instanceId, holder)
		.run()
		.catch(() => undefined);
}

/**
 * Start the next released ticket on this instance, or say why not. Never throws.
 *
 * One ticket per call, by design: the run it starts holds the instance until it ends, and the next
 * sweep after that picks the next ticket — the queue drains at the rate work completes.
 */
export async function pickupNextTicket(env: Env, instanceId: string, userId: string, deps: PickupDeps = {}): Promise<PickupResult> {
	const holder = crypto.randomUUID();
	let leased = false;
	try {
		if (!(await ticketQueueEnabled(env, instanceId, userId))) return { started: false, reason: "disabled" };
		if (!(await takeLease(env, instanceId, userId, holder))) return { started: false, reason: "leased" };
		leased = true;

		// One run at a time per instance. The coding driver refuses a second Pilot on a session by
		// itself; the chat loop has no such claim, so the queue holds the line for every driver.
		const running = await env.DB.prepare("SELECT 1 AS n FROM agent_loop_runs WHERE instance_id = ?1 AND user_id = ?2 AND status = 'running' LIMIT 1")
			.bind(instanceId, userId)
			.first<{ n: number }>();
		if (running) return { started: false, reason: "busy" };

		const { results } = await env.DB.prepare(
			`SELECT id, title, description FROM tickets
			  WHERE instance_id = ?1 AND user_id = ?2 AND pickup_authority = 'agent' AND queue_picked_at IS NULL
			  ORDER BY created_at, id LIMIT 50`,
		)
			.bind(instanceId, userId)
			.all<{ id: string; title: string; description: string }>();
		if (!results?.length) return { started: false, reason: "none" };

		// A ticket's status IS its card's — the human overlay included — so it is read from the board,
		// the one place that resolves it. A card a person moved to "Needs you" is not runnable here.
		const board = await buildInstanceBoard(env, instanceId, userId);
		const statusOf = new Map(board.items.filter((i) => i.ticketId).map((i) => [i.ticketId as string, i.status]));
		const next = results.find((t) => isQueueRunnable(statusOf.get(t.id)));
		if (!next) return { started: false, reason: "none" };

		const red = await (deps.redDeploy ?? redDeployBlocking)(env, instanceId, userId).catch(() => null);
		if (red) return { started: false, reason: "deploy_red", ticketId: next.id, detail: red };

		// The claim: WHERE still unpicked, so two sweeps that both reached here cannot both start it.
		const claim = await env.DB.prepare(
			`UPDATE tickets SET queue_picked_at = datetime('now'), queue_run_id = NULL, queue_note = NULL
			  WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3 AND pickup_authority = 'agent' AND queue_picked_at IS NULL`,
		)
			.bind(next.id, instanceId, userId)
			.run();
		if ((claim.meta?.changes ?? 0) === 0) return { started: false, reason: "raced", ticketId: next.id };

		const release = async (note: string) => {
			await env.DB.prepare("UPDATE tickets SET queue_picked_at = NULL, queue_note = ?4 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
				.bind(next.id, instanceId, userId, note.slice(0, 500))
				.run();
		};
		const refuse = async (note: string) => {
			await env.DB.prepare("UPDATE tickets SET queue_note = ?4 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
				.bind(next.id, instanceId, userId, note.slice(0, 500))
				.run();
		};

		// Its own budget, per start — the objective queue's rule (#184): a queue run is a separate run
		// the platform started, not a draw on whatever pool a previous run opened.
		let budgetId: string;
		let maxIterations: number;
		try {
			const ceilings = await resolveAccountCeilings(env, userId);
			const limits = await readLoopLimits(env, instanceId, userId).catch(() => ({}));
			maxIterations = clampIterations(sanitizeMaxIterations(undefined, ceilings.loopMaxIterations), limits, ceilings.loopMaxIterations);
			budgetId = (await openBudget(env, userId, instanceId)).id;
		} catch (e) {
			// A spent daily ceiling passes; the ticket keeps its place.
			const note = `budget refused: ${e instanceof Error ? e.message : String(e)}`;
			await release(note);
			return { started: false, reason: "budget", ticketId: next.id, detail: note };
		}

		const objective = `Ticket: ${next.title}${next.description ? `\n\n${next.description}` : ""}`.slice(0, MAX_OBJECTIVE);
		const start = deps.start ?? (async (input: LoopStartInput) => loopDriverFor(await capabilitiesForInstance(env, instanceId, userId).catch(() => null)).start(input));
		const started = await start({ env, instanceId, userId, objective, maxIterations, budgetId, depth: 0 });

		if (!started.ok) {
			if (started.reason === "busy") {
				// The session is being driven — waiting is the remedy, so the ticket goes back.
				await release(started.error);
				return { started: false, reason: "driver_busy", ticketId: next.id, detail: started.error };
			}
			// Structural (no repo, no runner, a checkout that failed admission): waiting fixes none of
			// it, so the ticket stays taken with the driver's own sentence until a person re-queues it.
			await refuse(started.error);
			return { started: false, reason: "refused", ticketId: next.id, detail: started.error };
		}

		await env.DB.prepare("UPDATE tickets SET queue_run_id = ?4 WHERE id = ?1 AND instance_id = ?2 AND user_id = ?3")
			.bind(next.id, instanceId, userId, started.runId)
			.run();
		const now = new Date().toISOString();
		// The run on the board, naming its ticket — how the board attaches a run to a ticket.
		await mirrorRuntimeTask(env, instanceId, userId, {
			id: started.runId,
			type: "ticket.run",
			status: "running",
			ticketId: next.id,
			title: next.title,
			objective,
			loopRunId: started.runId,
			driver: started.driver,
			createdAt: now,
			updatedAt: now,
		});
		await attachTicketRuns(env, instanceId, userId, [{ ticketId: next.id, taskId: started.runId, status: "running", updatedAt: now }]);
		return { started: true, ticketId: next.id, runId: started.runId, driver: started.driver };
	} catch (e) {
		await logError(env, { source: "loop", userId, message: `ticket queue pickup failed for ${instanceId}: ${e instanceof Error ? e.message : String(e)}`, context: { instanceId } }).catch(() => undefined);
		return { started: false, reason: "refused", detail: e instanceof Error ? e.message : String(e) };
	} finally {
		if (leased) await dropLease(env, instanceId, holder);
	}
}

/** The per-minute sweep: every instance whose owner turned the queue on and that holds a released ticket. */
export async function runTicketQueue(env: Env, deps: PickupDeps = {}, limit = 25): Promise<PickupResult[]> {
	const { results } = await env.DB.prepare(
		`SELECT q.instance_id, q.user_id FROM ticket_queues q
		   JOIN agent_instances i ON i.id = q.instance_id AND i.user_id = q.user_id
		  WHERE q.enabled = 1 AND i.status = 'active'
		    AND EXISTS (SELECT 1 FROM tickets t WHERE t.instance_id = q.instance_id AND t.user_id = q.user_id
		                AND t.pickup_authority = 'agent' AND t.queue_picked_at IS NULL)
		  LIMIT ?1`,
	)
		.bind(limit)
		.all<{ instance_id: string; user_id: string }>();
	const out: PickupResult[] = [];
	for (const r of results ?? []) out.push(await pickupNextTicket(env, r.instance_id, r.user_id, deps));
	return out;
}
