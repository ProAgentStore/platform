/**
 * Writes the runner's guards REFUSED, read back out of the Engine's own tool results (#1252).
 *
 * The runner gates a session's writes against its registered repositories where they happen: `git
 * push` in git's transport (`packages/browser-runner/src/coding/push-guard.ts`) and `gh` writes in its
 * shim (`gh-guard.ts`). A refusal exits before anything is sent and prints one line, which lands in
 * the result of the tool call that tried. That line is the record: the cloud does not re-derive the
 * target from the command, so `git push origin main` in a temp clone is named by the repository git
 * was actually about to write to.
 *
 * The two line shapes are contracts with those files — change them together:
 *
 *     pags: refused write-scope: git push to proagentstore/runner-router — this agent session is …
 *     pags: refused: `gh run cancel` writes to proappstore-online/tennis-clubs, which this agent session is not registered for …
 *
 * A refusal is CONTAINMENT, not a breach: nothing was written. It is recorded at `warn`, in the
 * instance's activity log and the run's trace, and stated in the run's evidence check — loud enough
 * that a misdirected run is seen, without the board card a landed out-of-scope write gets.
 */
import { logEvent } from "./events.js";
import type { Env } from "../types.js";

export interface WriteRefusal {
	/** What was refused, as the guard named it: `git push`, `gh run cancel`, `gh api`. */
	how: string;
	/** The repository it was aimed at, `owner/repo`, lower-cased by the guard. */
	repo: string;
}

const PUSH_LINE = /pags: refused write-scope: ([^\n]{1,80}?) to ([^\s—]{1,140}) —/g;
const GH_LINE = /pags: refused: `(gh [^`\n]{1,80})` writes to ([^\s,]{1,140}), which this agent session is not registered for/g;

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

/** The sentence the owner and the Pilot read. It leads with the repository, as #676's sentence does. */
export function describeWriteRefusal(r: WriteRefusal): string {
	return `Write to ${r.repo} refused: \`${r.how}\` was stopped by the write-scope guard before anything was sent — ${r.repo} is not one of this agent's registered repositories.`;
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
