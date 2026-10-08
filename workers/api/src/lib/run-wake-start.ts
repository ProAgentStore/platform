/**
 * Starting the woken agent's turn (#968) — the I/O half of `run-wake.ts`.
 *
 * Its own module rather than another branch inside `triggers.ts`: that file's dispatch chain is
 * already ~820 lines, and this action is the only one that opens a spend pool, resolves
 * capabilities and starts a run, so it carries the most to read. The decisions it makes about WHAT
 * the agent is told stay pure, next door.
 *
 * The run is started through `loopDriverFor` — the same door `start_work`, the Loop button and the
 * ticket queue use — so a coder gets its Pilot, everything else gets the chat loop, and the pause
 * and Pro gates apply here exactly as they do there.
 */
import { capabilitiesForInstance } from "./agent-capabilities.js";
import { HttpError } from "./auth.js";
import { openBudget } from "./delegation-budget-store.js";
import { loopDriverFor } from "./loop-drivers.js";
import { isWakeableEvent, wakeFactsOf, wakeObjective } from "./run-wake.js";
import type { TriggerConfig } from "./trigger-types.js";
import type { Env } from "../types.js";

const stringValue = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const payloadRecord = (p: unknown): Record<string, unknown> => (p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {});

/** The trigger/connection row this action runs for — only the fields it reads. */
export interface WakeTarget {
	instance_id: string;
	user_id: string;
}

export async function startWakeLoop(
	env: Env,
	target: WakeTarget,
	payload: unknown,
	config: TriggerConfig,
	mapped: { objective?: string },
): Promise<Record<string, unknown>> {
	// #968 — the action that was missing: have this agent take its NEXT TURN.
	//
	// No new delivery system, deliberately. A terminal `run.finished` / `run.stalled` is already
	// recorded per run (#579) and handed to the connection outbox every minute, and the outbox
	// already persists, retries with backoff, dead-letters and de-duplicates by
	// (connection, emitting run, payload hash). What was missing was something to DO on arrival.
	//
	// The loop is started through `loopDriverFor`, the same door `start_work`, the Loop button and
	// the ticket queue use — so a coder gets its Pilot and everything else gets the chat loop, and
	// the pause gate and the Pro gate apply here exactly as they do there.
	const facts = wakeFactsOf(payload);
	// The instruction, in the order of who is most specific about THIS turn: a mapped payload field,
	// an objective on the payload itself, then the standing one from the wiring.
	const instruction = mapped.objective || stringValue(payloadRecord(payload).objective) || config.objective || "";
	// Nothing terminal happened and nobody said what to do: not an error, just not a reason to spend
	// a turn. Reported rather than thrown, so a wiring that never fires is visible instead of filling
	// the outbox with dead letters.
	if (!isWakeableEvent(facts) && !instruction) return { started: false, reason: "not_wakeable" };
	const standing = (instruction || "Work out what the finished run means for your own work, and take the next step.").trim();
	// NEVER wake an agent for its OWN run ending. Without this, one connection wired source →
	// itself is an infinite paid loop: the woken turn ends, that end is recorded as another
	// `run.finished` on the same instance, which routes straight back here. The guard is at
	// EXECUTION rather than only at wiring because a self-edge can also arise indirectly — a
	// connection whose source and target were the same instance under a different name, or a
	// future producer that stamps the target's own id onto the payload.
	if (facts.instanceId && facts.instanceId === target.instance_id) {
		return { started: false, reason: "own_run" };
		}
	// Owner-scoped, checked here and not assumed: every caller reaches this with a (user,
	// instance) pair from one row, but the driver's own pause gate treats a MISSING row as "not
	// paused" and would go on to start a run. One indexed lookup closes that.
	const owns = await env.DB.prepare("SELECT 1 AS n FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(target.instance_id, target.user_id)
		.first<{ n: number }>();
	if (!owns) throw new HttpError(404, "That agent does not exist, or is not this owner's.");
	// ONE RUN AT A TIME per instance, the rule the ticket queue holds for every driver. A busy
	// agent is not a failed delivery and not a wake-up to drop: it WILL be free, so this throws
	// and the outbox's own backoff is the wait. Dropping it here would lose the signal silently,
	// which is the failure this issue is about.
	const running = await env.DB.prepare("SELECT 1 AS n FROM agent_loop_runs WHERE instance_id = ?1 AND user_id = ?2 AND status = 'running' LIMIT 1")
		.bind(target.instance_id, target.user_id)
		.first<{ n: number }>();
	if (running) throw new Error("That agent is already taking a turn; waiting for it to finish before waking it again.");
	const caps = await capabilitiesForInstance(env, target.instance_id, target.user_id).catch(() => null);
	const objective = wakeObjective(standing, facts);
	const parentTraceId = typeof config.traceId === "string" ? config.traceId : (facts.traceId ?? null);
	const started = await loopDriverFor(caps).start({
		env,
		instanceId: target.instance_id,
		userId: target.user_id,
		objective,
		// A wake-up is a ROOT run — nothing delegated it, so it opens its own spend pool, as
		// `delegateToInstance` does for a root delegation. The account ceilings apply to it there.
		budgetId: (await openBudget(env, target.user_id, target.instance_id)).id,
		// The wiring sets no iteration count: the instance's own loop limits govern it, the same
		// as every other start path.
		depth: 0,
	});
	// A refusal is thrown so the outbox retries it: a paused agent gets unpaused, a machine comes
	// back. Attempts are bounded by the outbox, which dead-letters and shows the reason.
	if (!started.ok) throw new Error(`the agent could not take a turn: ${started.error}`);
	return { started: true, runId: started.runId, driver: started.driver, wokeBy: facts.event ?? "payload", sourceRunId: facts.runId ?? null, sourceStatus: facts.status ?? null, parentTraceId };
}
