// Pausing an instance: the reversible half of the lifecycle that only had a destructive half (#825).
//
// ── What was missing, and what already existed
//
// `POST /:id/cancel` was the only lifecycle control an owner had. It writes
// `agent_instances.status = 'canceled'` and retires the shared subscription row, so "stop this
// agent for now" and "give up this agent" were the same button. The reported case is the ordinary
// one: a coding instance whose run went wrong, which the owner wanted quiet until they could look
// at it — not unsubscribed.
//
// `'paused'` has been in the column's declared domain since `0002_instances.sql` and has never had
// a writer. That was not an oversight and `lib/status-domain.ts` records the decision: the READ
// side was built for it deliberately and in advance, and this module is the writer it was waiting
// for. Specifically, already true before this file existed:
//
//   • `lib/trigger-eligibility.ts` gates every background dispatch on an ALLOWLIST
//     (`status = 'active'`) rather than `status != 'canceled'`, stating the reason outright: "if
//     pause ever acquires a writer, a paused instance must not be running cron work, and with an
//     allowlist it silently already does not" (#649). That covers the per-minute cron sweep, the
//     agent-to-agent pump, the delivery retry loop, the public webhook and the manual trigger run.
//   • `lib/subscription-standing.ts` and migration 0131 keep the `subscriptions` row STANDING for
//     any sibling instance not `'canceled'` — paused included — so pausing cannot retire the
//     subscription out from under a sibling.
//
// So this ticket is the four things that record names as absent: a writer, a resume path, a
// console control, and the run-admission gate. Shipping the writer alone is what makes a
// half-working control (#664), which is why they land together.
//
// ── What pause does NOT stop, and why that is a decision rather than an omission
//
// Interactive chat the OWNER types still works. Pause exists to stop work the platform starts on
// its own or that the owner starts as a RUN; a paused instance you cannot ask "what went wrong"
// is one you have to un-pause to diagnose, which defeats the reported case. Every path that
// SPENDS without the owner watching is gated — the five above, plus every `driver.start()` entry
// point through the gate below.
//
// A registered runner is also left alone. `pags up` keeps a paused instance in its membership,
// which costs nothing because no run can be admitted onto it; making the runner drop it would mean
// a resume needs the machine re-registered before it works, and that is a worse failure than an
// idle socket.
//
// ── Stopping the runs that are already going is a REQUEST, not a kill
//
// `requestCancel` sets `cancel_requested` on a running row; the run stops at the top of its next
// iteration, and `lib/run-sweeper.ts` enforces the ones that never read it (0150, #790). There is
// no way to kill a Workflow mid-step, so "paused" is honest about being the state it is entering
// rather than a state it has already reached — the route reports how many runs it ASKED to stop,
// and `check_instance_loop` is where a caller watches them actually stop.

import { ACTIVE_INSTANCE_STATUS } from "./trigger-eligibility.js";

/** The reversible stop. Declared in `0002_instances.sql`; written by this module and nothing else. */
export const PAUSED_INSTANCE_STATUS = "paused";

export function isPausedInstanceStatus(status: unknown): boolean {
	return status === PAUSED_INSTANCE_STATUS;
}

/**
 * The outcome of asking for a lifecycle transition.
 *
 * `changed` is separate from `ok` on purpose: pausing an already-paused instance is a SUCCESS that
 * wrote nothing, and a caller retrying after a dropped response must not be told it failed. The
 * MCP tools are the reason this matters — a model that reads an error re-asks, and re-asking a
 * pause that already happened should not look like a fight.
 */
export type LifecycleVerdict =
	| { ok: true; changed: boolean; status: string }
	| { ok: false; httpStatus: number; error: string };

/**
 * A cancelled instance is not pausable and not resumable, and the refusal says the one thing the
 * caller can act on.
 *
 * 409 rather than 404: the instance is right there and the request is well-formed; what is wrong
 * is its state. A caller reading 404 goes looking for a bad id.
 */
const CANCELLED_REFUSAL =
	"that instance is cancelled, not paused — subscribing to the agent again creates a new instance rather than reviving this one, so there is nothing here to pause or resume";

export function pauseVerdict(current: string | null | undefined): LifecycleVerdict {
	if (isPausedInstanceStatus(current)) return { ok: true, changed: false, status: PAUSED_INSTANCE_STATUS };
	if (current !== ACTIVE_INSTANCE_STATUS) return { ok: false, httpStatus: 409, error: CANCELLED_REFUSAL };
	return { ok: true, changed: true, status: PAUSED_INSTANCE_STATUS };
}

export function resumeVerdict(current: string | null | undefined): LifecycleVerdict {
	if (current === ACTIVE_INSTANCE_STATUS) return { ok: true, changed: false, status: ACTIVE_INSTANCE_STATUS };
	if (!isPausedInstanceStatus(current)) return { ok: false, httpStatus: 409, error: CANCELLED_REFUSAL };
	return { ok: true, changed: true, status: ACTIVE_INSTANCE_STATUS };
}

/**
 * What a run start is told when its instance is paused.
 *
 * Names the remedy, because the whole failure mode of a quiet gate is a caller retrying the thing
 * that cannot work. `resume_instance` is the exact tool name on the MCP surface and the exact verb
 * on the console control, so the sentence is actionable from either.
 */
export const PAUSED_RUN_REFUSAL =
	"this agent is paused, so no new run can start — resume it first (Settings → Pause, or resume_instance). Pausing does not touch its subscription, repos, documents or history.";

/**
 * The run-admission gate: may a run start on an instance in this status?
 *
 * Returns the refusal, or null to proceed. Deliberately does NOT ask
 * {@link isActiveInstanceStatus} and fail closed on everything else, which is what
 * `trigger-eligibility.ts` does for BACKGROUND work. The difference is who is waiting: that gate
 * spends money with nobody watching and so must refuse a status it has not been taught, while this
 * one sits in front of an owner pressing a button, where refusing on an unrecognised value would
 * turn a future status nobody has thought about yet into a silently unusable agent. Cancelled
 * instances are already refused upstream — every caller here has loaded the row through an
 * ownership check — so `paused` is the one state this has to answer for.
 */
export function pausedStartRefusal(status: string | null | undefined): string | null {
	return isPausedInstanceStatus(status) ? PAUSED_RUN_REFUSAL : null;
}
