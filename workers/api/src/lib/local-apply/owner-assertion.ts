/**
 * The owner's assertion that an uncertain submit sent nothing (#1073) —
 * `migrations/0238_application_owner_assertions.sql`.
 *
 * A pressed-but-unconfirmed submit blocks every later fill (`apply.ts`), and reconciliation cannot
 * prove SEEK history (#1013). The owner decided that THEIR explicit, audited word may stand in for
 * proof — once. So:
 *   - it is recorded as an assertion, in its own table, and never as reconciliation proof;
 *   - it binds to the exact attempt (application + the fill run whose submit was attempted);
 *   - it is spent by exactly ONE new fill, in the same batch that clears the attempt marker, so a
 *     second retry needs a second assertion and every later run traces back to the one it spent.
 * Without one, the hard block stays the default.
 */
import type { Env } from "../../types.js";
import { HttpError } from "../auth.js";
import { clipMarked } from "../clip-marked.js";
import { logEvent } from "../events.js";
import type { JobApplication } from "../local-artifact/store.js";
import { moveApplication } from "./store.js";

/** The exact words the owner confirms with, in the console and over MCP alike. */
export const NOT_SUBMITTED_CONFIRM = "I checked the employer site and nothing was submitted";
/** The statement is the owner's own evidence note, kept verbatim. */
export const NOT_SUBMITTED_STATEMENT_MAX = 1000;

export interface OwnerAssertion {
	id: string;
	applicationId: string;
	fillRunId: string;
	statement: string;
	actor: "owner_mcp" | "owner_console";
	priorSubmitAttemptedAt: number;
	createdAt: number;
	consumedAt: number | null;
	consumedRunId: string | null;
}

interface Row {
	id: string;
	application_id: string;
	fill_run_id: string;
	statement: string;
	actor: OwnerAssertion["actor"];
	prior_submit_attempted_at: number;
	created_at: number;
	consumed_at: number | null;
	consumed_run_id: string | null;
}

const present = (r: Row): OwnerAssertion => ({
	id: r.id,
	applicationId: r.application_id,
	fillRunId: r.fill_run_id,
	statement: r.statement,
	actor: r.actor,
	priorSubmitAttemptedAt: r.prior_submit_attempted_at,
	createdAt: r.created_at,
	consumedAt: r.consumed_at,
	consumedRunId: r.consumed_run_id,
});

type App = Pick<JobApplication, "id" | "instanceId" | "status" | "fillRunId" | "submitAttemptedAt" | "submittedAt">;

/** May the owner assert, for this application as it stands? An attempted, unconfirmed submit that no run holds. */
export function canAssertNotSubmitted(app: App, existing: OwnerAssertion | null): boolean {
	return !!app.submitAttemptedAt && !!app.fillRunId && !app.submittedAt && ["blocked", "deferred", "materials_ready"].includes(app.status) && !existing;
}

/** The assertion for the application's CURRENT attempt, spent or not. */
export async function assertionFor(env: Pick<Env, "DB">, userId: string, app: Pick<App, "id" | "fillRunId">): Promise<OwnerAssertion | null> {
	if (!app.fillRunId) return null;
	const row = await env.DB.prepare("SELECT * FROM application_owner_assertions WHERE application_id = ?1 AND fill_run_id = ?2 AND user_id = ?3 AND kind = 'not_submitted'")
		.bind(app.id, app.fillRunId, userId)
		.first<Row>();
	return row ? present(row) : null;
}

/** Does an UNSPENT assertion cover this application's attempted submit? What both fill guards ask. */
export async function hasUnspentAssertion(env: Pick<Env, "DB">, userId: string, app: Pick<App, "id" | "fillRunId" | "submitAttemptedAt">): Promise<boolean> {
	if (!app.submitAttemptedAt) return false;
	const a = await assertionFor(env, userId, app);
	return !!a && a.consumedAt === null;
}

/** Record it. One per attempt: a repeat returns the existing row. */
export async function recordNotSubmittedAssertion(
	env: Pick<Env, "DB">,
	input: { app: App; userId: string; statement: string; actor: OwnerAssertion["actor"] },
	now: number,
): Promise<OwnerAssertion> {
	const { app } = input;
	await env.DB.prepare(
		`INSERT INTO application_owner_assertions (id, application_id, instance_id, user_id, fill_run_id, kind, statement, actor, prior_submit_attempted_at, created_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, 'not_submitted', ?6, ?7, ?8, ?9)
		 ON CONFLICT (application_id, fill_run_id, kind) DO NOTHING`,
	)
		.bind(crypto.randomUUID(), app.id, app.instanceId, input.userId, app.fillRunId, input.statement, input.actor, app.submitAttemptedAt, now)
		.run();
	return (await assertionFor(env, input.userId, app)) as OwnerAssertion;
}

/**
 * Spend the assertion on the run about to start, and clear the attempt marker it covers — one
 * batch, each half guarded on the other, so a second fill can never reuse it. False when there was
 * nothing unspent to spend (already spent, or never made).
 */
export async function consumeNotSubmittedAssertion(env: Pick<Env, "DB">, input: { app: App; userId: string; runId: string }, now: number): Promise<boolean> {
	const { app } = input;
	await env.DB.batch([
		env.DB.prepare(
			"UPDATE application_owner_assertions SET consumed_at = ?1, consumed_run_id = ?2 WHERE application_id = ?3 AND fill_run_id = ?4 AND user_id = ?5 AND kind = 'not_submitted' AND consumed_at IS NULL",
		).bind(now, input.runId, app.id, app.fillRunId, input.userId),
		env.DB.prepare(
			`UPDATE job_applications SET submit_attempted_at = NULL
			  WHERE id = ?1 AND user_id = ?2 AND fill_run_id = ?3
			    AND EXISTS (SELECT 1 FROM application_owner_assertions WHERE application_id = ?1 AND fill_run_id = ?3 AND consumed_run_id = ?4)`,
		).bind(app.id, input.userId, app.fillRunId, input.runId),
	]);
	// Read back rather than trust a batch's per-statement change count: THIS run spent it, or it lost.
	const owner = await env.DB.prepare("SELECT consumed_run_id FROM application_owner_assertions WHERE application_id = ?1 AND fill_run_id = ?2 AND user_id = ?3 AND kind = 'not_submitted'")
		.bind(app.id, app.fillRunId, input.userId)
		.first<{ consumed_run_id: string | null }>();
	return owner?.consumed_run_id === input.runId;
}

/**
 * The `assert_not_submitted` application action — the console button and the MCP tool both arrive here.
 * The caller has already checked the item offers it. Refused (nothing recorded) without the exact
 * declaration, without the owner's words, or for any run but the application's current attempt.
 */
export async function assertNotSubmitted(
	env: Pick<Env, "DB">,
	input: { app: JobApplication; userId: string; instanceId: string; input: { confirm?: string; statement?: string; fillRunId?: string; surface?: "mcp" | "console" } },
	now: number,
): Promise<OwnerAssertion> {
	const { app, userId, instanceId } = input;
	const { confirm, statement = "", fillRunId, surface } = input.input;
	if (confirm !== NOT_SUBMITTED_CONFIRM) throw new HttpError(400, `Confirm with exactly: "${NOT_SUBMITTED_CONFIRM}".`);
	if (!statement || statement.length > NOT_SUBMITTED_STATEMENT_MAX) throw new HttpError(400, `statement is required: what you checked, in your words (up to ${NOT_SUBMITTED_STATEMENT_MAX} characters).`);
	// Bound to the attempt the owner actually checked: a different run's id is a different claim.
	if (!fillRunId || fillRunId !== app.fillRunId) throw new HttpError(409, `fill_run_id must be this application's current attempt (${app.fillRunId ?? "none"}); nothing was recorded.`);
	const assertion = await recordNotSubmittedAssertion(env, { app, userId, statement, actor: surface === "mcp" ? "owner_mcp" : "owner_console" }, now);
	// The lifecycle audit row: blocked stays blocked (the retry is the owner's next step); a deferred
	// application comes back to materials_ready so it can be filled.
	if (app.status === "blocked" || app.status === "deferred") {
		const moved = await moveApplication(env, app, userId, {
			to: app.status === "blocked" ? "blocked" : "materials_ready",
			actor: "owner",
			actorInstanceId: instanceId,
			runId: app.fillRunId ?? undefined,
			reason: "owner_asserted_not_submitted",
			questions: [`You recorded that nothing was submitted: "${clipMarked(statement, 300, { within: true })}". That is your assertion, not proof from the site. One new fill is now allowed.`],
		}, now);
		if (!moved) throw new HttpError(409, "The application changed meanwhile — reload it and assert again.");
	}
	await logEvent(env, { source: "tool", event: "application.owner_asserted_not_submitted", message: "owner asserted an uncertain submit sent nothing", userId, instanceId, level: "warn", context: { applicationId: app.id, fillRunId: app.fillRunId, assertionId: assertion.id, actor: assertion.actor, priorSubmitAttemptedAt: assertion.priorSubmitAttemptedAt } }).catch(() => undefined);
	return assertion;
}
