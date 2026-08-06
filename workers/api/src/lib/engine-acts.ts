/**
 * Consequential acts arriving from a runner (#294) — the cloud half.
 *
 * A delegated run wrote down its objective and its outcome and nothing in between. Run `73ffc073`
 * merged its own PRs to `main` unattended and `subordinate_status` said "done". The delegation
 * model rests on a supervisor being able to REVIEW what a subordinate did; without a record of the
 * irreversible acts, all it can review is whether the subordinate claimed success.
 *
 * ── NO FIFTH RECORD OF "WHAT HAPPENED" ──
 *
 * These go into `agent_events` (migration 0038), the unified trace already read by
 * `GET /v1/instances/:id/trace` and the MCP `agent_trace` tool. The #150 P2 agent explicitly
 * refused to add storage for a similar need and reused `instance_runtime_task_events`; the same
 * reasoning holds, and it buys more here than it costs — an act is visible in the trace, in MCP and
 * filterable by run, on day one, with nothing new to teach anybody.
 *
 * ── WHY THE EVENT NAME IS GENERIC ──
 *
 * `event: "act.consequential"` with `source` naming the subsystem, NOT `coding.act`. Supervision
 * reads these (see `instance-work.ts`), and that module is deliberately forbidden from importing a
 * domain module — the coupling migration 0063 removed and a first attempt at supervision
 * re-introduced. A generic event name keeps that intact: supervision reads "consequential acts",
 * and a pipeline that deploys or an MCP write tool can start writing the same record and appear in
 * the supervisor's view with no change to supervision at all.
 */
import { logEvent } from "./events.js";
import type { Env } from "../types.js";

/** One act as the runner reports it. Mirrors `EngineActRecord` in the browser-runner package. */
export interface EngineActReport {
	id: string;
	kind: string;
	command: string;
	target: string | null;
	irreversible: boolean;
	ok: boolean | null;
	at: string;
}

/** Cap per drain — a compromised or buggy runner must not be able to bulk-insert into D1. */
const MAX_RECORDS = 100;
const MAX_COMMAND = 400;

/**
 * The act kinds the platform will record.
 *
 * A CLOSED list, checked here rather than passed through, because `kind` is rendered into a
 * supervisor's prompt and read by a model. An open string field would let a runner (or anything
 * that can impersonate one) inject a sentence into that prompt through a field the reader treats as
 * an enum.
 */
const KNOWN_KINDS = new Set([
	"pr.merge",
	"pr.open",
	"push",
	"push.trunk",
	"push.force",
	"branch.delete",
	"reset.hard",
	"clean",
	"file.delete",
	"release.publish",
	"package.publish",
	"repo.delete",
	"deploy",
]);

/** Acts that cannot simply be undone — the ones a supervisor is being asked to notice. */
const IRREVERSIBLE = new Set([
	"pr.merge",
	"push.trunk",
	"push.force",
	"branch.delete",
	"reset.hard",
	"clean",
	"file.delete",
	"release.publish",
	"package.publish",
	"repo.delete",
	"deploy",
]);

/**
 * Validate a runner's reported acts into records worth writing.
 *
 * The payload crosses the relay from a machine the platform does not control, so it is treated as
 * input rather than as truth about types — the same posture as `sanitizeEngineUsage`.
 *
 * `irreversible` is RECOMPUTED from `kind` rather than trusted: it is the field that decides how
 * loudly an act is surfaced, so a runner that reported `pr.merge` with `irreversible: false` could
 * otherwise downgrade the one act this whole feature exists to make loud.
 */
export function sanitizeEngineActs(raw: unknown): EngineActReport[] {
	if (!Array.isArray(raw)) return [];
	const out: EngineActReport[] = [];
	const seen = new Set<string>();
	for (const item of raw.slice(0, MAX_RECORDS)) {
		if (!item || typeof item !== "object") continue;
		const r = item as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id.trim().slice(0, 200) : "";
		// No id means no dedup key, and a duplicated "merged to main" reads as a second merge that
		// never happened. Drop it rather than write something a supervisor could double-count.
		if (!id || seen.has(id)) continue;
		const kind = typeof r.kind === "string" ? r.kind.trim() : "";
		if (!KNOWN_KINDS.has(kind)) continue;
		const command = typeof r.command === "string" ? r.command.trim().slice(0, MAX_COMMAND) : "";
		if (!command) continue;
		seen.add(id);
		out.push({
			id,
			kind,
			command,
			target: typeof r.target === "string" && r.target.trim() ? r.target.trim().slice(0, 120) : null,
			irreversible: IRREVERSIBLE.has(kind),
			// Anything that is not literally true/false is UNKNOWN. Coercing a missing value to
			// `true` would be the platform inventing a successful merge.
			ok: r.ok === true ? true : r.ok === false ? false : null,
			at: typeof r.at === "string" && r.at.trim() ? r.at.trim().slice(0, 40) : new Date().toISOString(),
		});
	}
	return out;
}

/** Phrasing per kind — plain language, because the primary reader is a model and then a human. */
const PHRASE: Record<string, string> = {
	"pr.merge": "merged a pull request",
	"pr.open": "opened a pull request",
	push: "pushed a branch",
	"push.trunk": "pushed directly to the trunk",
	"push.force": "force-pushed (rewrote published history)",
	"branch.delete": "deleted a branch",
	"reset.hard": "hard-reset the working tree",
	clean: "force-cleaned the working tree",
	"file.delete": "deleted files recursively",
	"release.publish": "published a release",
	"package.publish": "published a package",
	"repo.delete": "deleted a repository",
	deploy: "deployed",
};

/**
 * One sentence naming the act, its subject and whether it worked.
 *
 * The outcome is stated explicitly in all three states. "merged a pull request #42" with no
 * qualifier would be read as a completed merge, so a failed one says so and an unobserved one says
 * that too — the distinction between "it merged" and "we did not see whether it merged" is the
 * whole difference between an audit trail and a guess.
 */
export function describeEngineAct(act: Pick<EngineActReport, "kind" | "target" | "ok">): string {
	const base = PHRASE[act.kind] ?? act.kind;
	const subject = act.target ? ` ${act.target}` : "";
	const outcome = act.ok === false ? " — FAILED" : act.ok === null ? " — outcome not observed" : "";
	return `${base}${subject}${outcome}`;
}

/** How many acts a one-line run summary names before it says "and N more". */
const MAX_SUMMARY_ACTS = 4;

/**
 * One line naming what a run DID, for the places a supervisor reads without asking a second
 * question — the delegated run's `detail` and its board card.
 *
 * The trace holds the full record, but a supervisor's default read is `check_delegation` /
 * `subordinate_status`, and #294's acceptance says they must see it "without opening the repo".
 * Making them fetch the trace to discover a merge would rebuild the same gap one call further out.
 *
 * IRREVERSIBLE ACTS COME FIRST and the reversible tail is only counted. When a run pushes eleven
 * branches and merges one, the merge is the sentence — ordering by time would bury it.
 *
 * Returns null for a run with no observed acts. A padded "no consequential acts" would be a claim
 * this cannot make: a raw engine reports nothing, so silence means "not observed".
 */
export function summarizeActs(acts: ReadonlyArray<{ summary: string; irreversible: boolean }>): string | null {
	if (!acts.length) return null;
	const ordered = [...acts].sort((a, b) => Number(b.irreversible) - Number(a.irreversible));
	const named = ordered.slice(0, MAX_SUMMARY_ACTS).map((a) => a.summary);
	const rest = ordered.length - named.length;
	return `Acts: ${named.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}.`;
}

/**
 * The trace row's primary key for an act.
 *
 * Deterministic for the same reason the usage ledger's is: several cloud paths can drain and write
 * the same act (a console capture poll racing the Pilot's own capture, or a retried workflow step),
 * and `INSERT OR IGNORE` on this key turns that into a no-op. Namespaced by session so two sessions
 * cannot collide on an engine-supplied tool_use id.
 */
export function engineActRowId(sessionId: string, recordId: string): string {
	return `act:${sessionId}:${recordId}`.slice(0, 300);
}

/**
 * Write acts to the unified trace.
 *
 * `level` is `warn` for an irreversible act. That is not "something went wrong" — in this trace the
 * levels are the only queryable severity band, and `warn` is the "a human should look at this" one.
 * An unattended merge to `main` is precisely that, and it means `GET /trace?level=warn` and the MCP
 * `agent_trace` tool surface it with no new filter dimension.
 */
export async function recordEngineActs(
	env: Env,
	ctx: { userId: string; instanceId: string; sessionId: string; traceId?: string | null },
	acts: EngineActReport[],
): Promise<void> {
	for (const act of acts) {
		await logEvent(env, {
			id: engineActRowId(ctx.sessionId, act.id),
			source: "coding",
			event: "act.consequential",
			level: act.irreversible ? "warn" : "info",
			userId: ctx.userId,
			instanceId: ctx.instanceId,
			// The RUN when one is driving, so `/trace?trace_id=<runId>` reconstructs exactly what
			// that delegation did; the session otherwise. Never both, and never a guess.
			traceId: ctx.traceId || ctx.sessionId,
			message: describeEngineAct(act),
			context: {
				act: act.kind,
				command: act.command,
				target: act.target,
				irreversible: act.irreversible,
				ok: act.ok,
				sessionId: ctx.sessionId,
			},
			ts: Date.parse(act.at) || Date.now(),
		});
	}
}
