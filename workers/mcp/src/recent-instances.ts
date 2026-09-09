import { type SafetyContext, subjectFor } from "./safety.js";

/**
 * Which instances THIS caller drove most recently over MCP (#787).
 *
 * ── The gap this fills
 *
 * "What was I working on?" had no answer on this surface. `my_instances` is the whole roster —
 * dozens of instances, ordered by the instance's OWN `last_activity_at`, which a scheduled trigger
 * moves as readily as a person does — and `coding_loop_status` needs an id the caller already has.
 * Nothing recorded the third thing, which is the one a fresh conversation actually wants: the
 * instances the account itself issued tool calls against, newest first.
 *
 * It could not be read out of the audit log. `audit()` writes only on write, runtime, dry-run,
 * denied and destructive events, and `requirePermission` writes only on a denial — a caller that
 * polled `coding_loop_status` on one instance for an hour left no row anywhere (`base.ts`'s #578
 * note measures the same absence). So the signal is recorded here, on purpose, as its own thing.
 *
 * ── Where it is recorded, and why there
 *
 * From the registration pipeline (`registration.ts`), not from the handlers. That is the seam #273
 * built so a gate cannot be forgotten on the tool nobody has written yet, and a recency signal has
 * the same failure mode: a per-handler line covers the ~80 tools that take an `instance_id` today
 * and misses the next one. The pipeline sees every call's name and first argument, so one hook
 * covers the surface — and on a `/mcp/i/<id>` session (#783), where no argument names the
 * instance, index.ts hands it the pinned id instead.
 *
 * ── Storage
 *
 * ONE KV KEY PER (subject, instance): `recent:{subject}:{instance}` → `{instance, tool, at}`, in
 * the same `OAUTH_KV` namespace the audit trail uses, under a different prefix. Per-instance keys
 * rather than one list per subject because a list is a read-modify-write, and two tool calls in
 * flight at once (a client fanning out `coding_loop_status` across instances) would each write
 * the other's entry away. A put per key has no such race, and the read side lists the prefix and
 * sorts — bounded by how many instances one account has touched in {@link RECENT_INSTANCE_TTL}.
 *
 * `instance` is stored AS THE CALLER WROTE IT. Coding tools accept a slug (`resolveId`), and
 * resolving here would cost a roster fetch on every call; the reader joins against the roster once
 * instead, by id or slug, and drops anything that no longer resolves (a cancelled instance, a slug
 * whose agent is gone) — so the list can never name an instance the caller cannot reach.
 *
 * A subject-less call (unauthenticated, or a per-call `token` that does not verify) records
 * nothing, exactly as `audit()` does: an unverified token must never become an identity.
 *
 * ── The throttle
 *
 * KV allows one write per second per key, and a supervising client polls `coding_loop_status`
 * faster than that. So a DO remembers when it last wrote each (subject, instance) and skips writes
 * inside {@link TOUCH_WRITE_INTERVAL_MS}. The cost is that `tool` names the FIRST call of a window
 * rather than the last, and `at` lags by up to the window — both immaterial to an ordering whose
 * unit is "which conversation was this". The memo is per Durable Object, i.e. per MCP session,
 * which is bounded by the instances one session touches.
 */

/** How long an interaction stays on the list. Thirty days: long enough that "last week's run"
 *  is still there, short enough that the prefix listing stays small. */
export const RECENT_INSTANCE_TTL = 30 * 86_400;

/** Minimum gap between two KV writes for one (subject, instance). */
export const TOUCH_WRITE_INTERVAL_MS = 30_000;

/** How many instances `recent_instances` returns. The ticket's number, and a screenful. */
export const RECENT_INSTANCES_LIMIT = 5;

export interface InstanceTouch {
	/** The `instance_id` argument as the caller passed it — an id, or a slug a coding tool accepts. */
	instance: string;
	/** The tool that touched it (first call of the throttle window). */
	tool: string;
	/** ISO time of that call. */
	at: string;
}

/** The per-session write memo — held by the caller so it survives across `safety()` calls. */
export interface TouchThrottle {
	lastWrite: Map<string, number>;
}

export function newTouchThrottle(): TouchThrottle {
	return { lastWrite: new Map() };
}

/**
 * The instance a tool call was about: the pinned instance on a `/mcp/i/<id>` session, else the
 * call's own `instance_id` argument, else nothing. `agent_id`, `supervisor_instance_id` and the
 * like are deliberately NOT read — the first is not an instance, and the others name a party to
 * the call rather than the thing the caller is driving.
 */
export function touchedInstance(input: unknown, pinned?: string): string | undefined {
	if (pinned) return pinned;
	const id = (input as { instance_id?: unknown } | undefined)?.instance_id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

export async function recordInstanceTouch(
	ctx: SafetyContext,
	tool: string,
	instance: string | undefined,
	throttle: TouchThrottle,
	now: number = Date.now(),
): Promise<void> {
	if (!instance || !ctx.env.OAUTH_KV) return;
	const subject = await subjectFor(ctx);
	if (!subject) return;
	const memo = `${subject}:${instance}`;
	const last = throttle.lastWrite.get(memo);
	if (last !== undefined && now - last < TOUCH_WRITE_INTERVAL_MS) return;
	throttle.lastWrite.set(memo, now);
	const touch: InstanceTouch = { instance, tool, at: new Date(now).toISOString() };
	try {
		await ctx.env.OAUTH_KV.put(`recent:${subject}:${instance}`, JSON.stringify(touch), { expirationTtl: RECENT_INSTANCE_TTL });
	} catch {
		// A recency hint must never fail the tool call it rides on. The likely cause is KV's
		// per-key write rate, which the throttle above already makes rare; the next call retries.
	}
}

/** Every recorded interaction for this subject, newest first. Empty without a KV or a subject. */
export async function listInstanceTouches(ctx: SafetyContext): Promise<InstanceTouch[]> {
	const kv = ctx.env.OAUTH_KV;
	if (!kv) return [];
	const subject = await subjectFor(ctx);
	if (!subject) return [];
	const listed = await kv.list({ prefix: `recent:${subject}:`, limit: 1000 });
	const values = await Promise.all(listed.keys.map((k) => kv.get(k.name)));
	const touches: InstanceTouch[] = [];
	for (const raw of values) {
		if (!raw) continue;
		try {
			touches.push(JSON.parse(raw) as InstanceTouch);
		} catch {
			// A value that is not JSON is not one this module wrote; skipping it keeps the list honest
			// rather than failing the whole read over one bad key.
		}
	}
	return touches.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
