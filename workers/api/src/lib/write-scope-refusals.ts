/**
 * Writes the runner's guards REFUSED, read back out of the Engine's own tool results (#1252), and a
 * push the real transport never answered at all (#1403).
 *
 * The runner gates a session's writes against its registered repositories where they happen: `git
 * push` in git's transport (`packages/browser-runner/src/coding/push-guard.ts`) and `gh` writes in its
 * shim (`gh-guard.ts`). A refusal exits before anything is sent and prints one line, which lands in
 * the result of the tool call that tried. That line is the record: the cloud does not re-derive the
 * target from the command, so `git push origin main` in a temp clone is named by the repository git
 * was actually about to write to.
 *
 * The three line shapes are contracts with those files — change them together:
 *
 *     pags: refused write-scope: git push to proagentstore/runner-router — this agent session is …
 *     pags: refused: `gh run cancel` writes to proappstore-online/tennis-clubs, which this agent session is not registered for …
 *     pags: push timed out: proappstore-online/platform did not complete within 45s — delegated to …
 *
 * A refusal is CONTAINMENT, not a breach: nothing was written. A timeout is different — the push was
 * IN scope and may or may not have landed; the push guard bounds it so this is known within seconds
 * rather than the Engine's own ~120s outer kill (rc=124, no message). Both are recorded at `warn`, in
 * the instance's activity log and the run's trace — a refusal is stated in the run's evidence check
 * too, loud enough that a misdirected run is seen without the board card a landed out-of-scope write
 * gets; a timeout is not (whether it landed is unknown, which is a different claim than "refused").
 */
import { logEvent } from "./events.js";
import type { Env } from "../types.js";

export interface WriteRefusal {
	/** What was refused, as the guard named it: `git push`, `gh run cancel`, `gh api`. */
	how: string;
	/** The repository it was aimed at, `owner/repo`, lower-cased by the guard. */
	repo: string;
}

/** A push the push guard's bounded wait gave up on (#1403) — IN scope, outcome unknown. */
export interface PushTimeout {
	/** The repository the push was aimed at, `owner/repo`, lower-cased by the guard. */
	repo: string;
	/** How many seconds the helper waited before giving up. */
	seconds: number;
}

const PUSH_LINE = /pags: refused write-scope: ([^\n]{1,80}?) to ([^\s—]{1,140}) —/g;
const GH_LINE = /pags: refused: `(gh [^`\n]{1,80})` writes to ([^\s,]{1,140}), which this agent session is not registered for/g;
const PUSH_TIMEOUT_LINE = /pags: push timed out: (\S{1,140}) did not complete within (\d+)s/g;

/** Every refusal line in a tool result, deduplicated, in order. */
export function writeRefusalsIn(text: string | null | undefined): WriteRefusal[] {
	const s = String(text ?? "");
	const out: WriteRefusal[] = [];
	const seen = new Set<string>();
	for (const re of [PUSH_LINE, GH_LINE]) {
		re.lastIndex = 0;
		for (const m of s.matchAll(re)) {
			const r = { how: m[1].trim(), repo: m[2] };
			const key = `${r.how} ${r.repo}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(r);
		}
	}
	return out;
}

/** Every push-timeout line in a tool result, deduplicated, in order. */
export function pushTimeoutsIn(text: string | null | undefined): PushTimeout[] {
	const s = String(text ?? "");
	const out: PushTimeout[] = [];
	const seen = new Set<string>();
	PUSH_TIMEOUT_LINE.lastIndex = 0;
	for (const m of s.matchAll(PUSH_TIMEOUT_LINE)) {
		const t = { repo: m[1], seconds: Number(m[2]) };
		const key = `${t.repo} ${t.seconds}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(t);
	}
	return out;
}

/** The sentence the owner and the Pilot read. It leads with the repository, as #676's sentence does. */
export function describeWriteRefusal(r: WriteRefusal): string {
	return `Write to ${r.repo} refused: \`${r.how}\` was stopped by the write-scope guard before anything was sent — ${r.repo} is not one of this agent's registered repositories.`;
}

/** The sentence the owner and the Pilot read for a timed-out push — never "refused": it was in scope. */
export function describePushTimeout(t: PushTimeout): string {
	return `Push to ${t.repo} did not complete within ${t.seconds}s and was stopped before the Engine's own tool-call timeout could — check credential.helper, network, or github.com reachability, then retry.`;
}

/**
 * Record one refusal in the instance's activity log (`instance_activity`) and the run's trace
 * (`agent_trace`). Never throws: a record must not change what the run does.
 */
export async function recordWriteRefusal(env: Env, ctx: { userId: string; instanceId: string; sessionId: string; traceId?: string | null }, r: WriteRefusal): Promise<void> {
	const message = describeWriteRefusal(r);
	await logEvent(env, {
		source: "coding",
		event: "write.refused",
		level: "warn",
		userId: ctx.userId,
		instanceId: ctx.instanceId,
		traceId: ctx.traceId || ctx.sessionId,
		message,
		context: { how: r.how, repo: r.repo, sessionId: ctx.sessionId },
	}).catch(() => undefined);
	await env.AGENT.get(env.AGENT.idFromName(ctx.instanceId))
		.fetch(
			new Request("https://agent/activity/write-refused", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId: ctx.userId, data: { how: r.how, repo: r.repo, sessionId: ctx.sessionId, message } }),
			}),
		)
		.catch(() => undefined);
}

/**
 * Record one push timeout (#1403), the same way {@link recordWriteRefusal} does — activity log plus
 * the run's trace, never throwing — so the cause is seen within seconds instead of only the opaque
 * rc=124 an outer kill would have left behind.
 */
export async function recordPushTimeout(env: Env, ctx: { userId: string; instanceId: string; sessionId: string; traceId?: string | null }, t: PushTimeout): Promise<void> {
	const message = describePushTimeout(t);
	await logEvent(env, {
		source: "coding",
		event: "push.timeout",
		level: "warn",
		userId: ctx.userId,
		instanceId: ctx.instanceId,
		traceId: ctx.traceId || ctx.sessionId,
		message,
		context: { repo: t.repo, seconds: t.seconds, sessionId: ctx.sessionId },
	}).catch(() => undefined);
	await env.AGENT.get(env.AGENT.idFromName(ctx.instanceId))
		.fetch(
			new Request("https://agent/activity/push-timeout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId: ctx.userId, data: { repo: t.repo, seconds: t.seconds, sessionId: ctx.sessionId, message } }),
			}),
		)
		.catch(() => undefined);
}
