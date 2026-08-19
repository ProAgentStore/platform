/**
 * Status columns: what values are DECLARED, and which of them application code can actually write.
 *
 * ## Why this exists
 *
 * Three separate bugs landed on 2026-08-15, and all three are one defect wearing three faces:
 *
 *   • #570 — `instance_runtime_nodes.status` had no writer for any value but `"online"`, and
 *     `runtimeNodeResponse` published it. Four machines read `online`, three of them last seen
 *     days earlier.
 *   • #587 — the same column's routing gate, `lib/runner-client.ts:73`, selects a runner
 *     `WHERE status != 'offline'` — a decision taken on a value nothing could write, so a machine
 *     that had gone away stayed eligible for routing. And `instance_runtimes.status` was published
 *     raw beside a derived one, in the same response object.
 *   • #590 — `agents.status`: `run.ts` gated `/run` on `status === "active"`, which only nine seed
 *     migrations have ever written. Every third-party published agent 404'd for every non-owner,
 *     permanently.
 *
 * The shape is always: **a decision is taken on a value the application cannot produce.** It is
 * invisible in review because the reading code is correct, the writing code is correct, and what
 * is wrong is the gap between them — which lives in no file. It is invisible in tests because a
 * test supplies the value the production writer never does.
 *
 * A per-column test cannot catch the fourth one. This table plus `status-domain-guard.ts` is the
 * check that can: every status column in the schema is declared here with the PROVENANCE of each
 * value, and the guard fails when code decides on a value marked as unreachable from application
 * code.
 *
 * ## Provenance, not just a value list
 *
 * `app`  — application code writes this value as a literal, and the scanner proves it.
 * `app?` — application code writes it, but through an indirection the scanner cannot follow: a
 *          value bound from a variable whose literal lives at a caller, a value passed through
 *          from an external provider, or a `SET` clause built at runtime. Writable, so deciding on
 *          it is legitimate — but the note must say WHERE, because this is the marking that could
 *          otherwise be used to wave the guard through. The scanner asserts it finds NO direct
 *          writer for these, so one that becomes findable has to be promoted to `app`.
 * `seed`  — only a migration writes it (a seeded first-party row, or a column DEFAULT that no
 *           INSERT overrides). It exists in the data and may be READ and displayed; deciding on it
 *           means the decision can never go the other way for anything the application creates.
 * `none`  — nothing writes it anywhere. Dead vocabulary.
 *
 * `seed` and `none` are what the guard polices. Every marking is asserted against the source in
 * BOTH directions, so it cannot quietly go stale: add the writer that `agents.status = 'error'`
 * has never had and the guard fails until this table says so — and the first draft of this table
 * claimed `subscriptions.status = 'past_due'` was written by the Stripe webhook, which the scanner
 * disproved. That is the assertion earning its place on its first run.
 *
 * ## Two things this file adds, and one it still does not cover
 *
 * `decisions` (#598) closes the gap the three bugs left behind: the guard stopped code DECIDING
 * on an unwritable value, but said nothing about the values themselves, so four of them sat
 * declared with no record of whether each was a feature nobody had built or a word that was never
 * going to mean anything. Those have opposite fixes, and the silence is what invites the next
 * reader to write the plausible-looking branch. Every unwritable value now carries its answer,
 * asserted as an exact set.
 *
 * **The labelled gap: a decision on a value that is not in the declared domain AT ALL.** This
 * table polices values that are declared but unwritable. It cannot see a filter that names a
 * value which was never a member — and that is the same defect one step further out. Two of them
 * were live while this file already existed:
 *
 *   • #638 — the admin Ops queue filtered `coding_sessions.status IN ('failed', 'needs_human',
 *     'blocked')`. None of the three is a `CodingSessionStatus`, so the branch could never match,
 *     and the queue reported "No stuck sessions" while sessions sat in `'error'`.
 *   • #625 — the console counted a run finished on `'expired'`, which is not a member of the
 *     runner's `TaskStatus` and which #611 had already removed from the api-side filter.
 *
 * Both were fixed by pinning the reader to the TYPE that declares the domain (`as const satisfies
 * readonly CodingSessionStatus[]`, `readonly TaskStatus[]`), which is a per-site fix. A scanner
 * over this table could catch the class, the way the one below catches decisions on `seed`/`none`
 * — it is not written, and that is a gap, not an absence of the problem.
 */

export type Provenance = "app" | "app?" | "seed" | "none";

/** Can application code produce this value at all? `app` and `app?` both mean yes. */
export const isWritable = (p: Provenance): boolean => p === "app" || p === "app?";

export interface StatusDomain {
	/** Declared value → who can write it. */
	values: Record<string, Provenance>;
	/** Why the non-`app` values are as they are. Read by a human, never by the guard. */
	note?: string;
	/**
	 * The DECISION taken about each unwritable value: whether a writer is coming, or whether the
	 * word is dead and stays dead — and in either case, why (#598).
	 *
	 * Required, and asserted as an EXACT set against the unwritable values of the column
	 * (`status-domain.test.ts`). A value that gains a writer must lose its entry; one that loses
	 * its writer must gain one. That is the whole point: an unwritable value with no recorded
	 * decision is a trap left for the next reader, who has no way to tell "nobody has built this
	 * yet" from "this was deliberately never a thing" — and the two have opposite fixes.
	 *
	 * ── Why "remove it from the declared domain" is usually not on the menu
	 *
	 * The declaration is a trailing comment in a SHIPPED migration (`0001_init.sql:11`,
	 * `0002_instances.sql:7`), and a migration that has run is history: `check-migrations.mjs
	 * --require-history` fails on a DDL edit, and SQLite has no way to amend a column comment
	 * anyway. So for a schema-declared value the only two expressible outcomes are "add a writer"
	 * and "record that there is none". This field is the second one.
	 */
	decisions?: Record<string, string>;
}

/**
 * Keyed `table.column`. The guard asserts this covers EXACTLY the status columns whose value
 * domain the schema declares (a trailing comment on the column, the convention this repo has used
 * since `0001_init.sql`), so a new declared status column cannot be added without landing here.
 */
export const STATUS_DOMAINS: Record<string, StatusDomain> = {
	"agents.status": {
		values: { inactive: "app", active: "seed", error: "none" },
		note:
			"#590. All three `INSERT INTO agents` write 'inactive'; the update allowlist " +
			"(routes/agents.ts) has no `status` entry and no `UPDATE agents` anywhere sets it. Only " +
			"the nine seed migrations write 'active'. 'error' has never been written by anything. " +
			"`/run` gated on 'active' and so was closed to every third-party creator; that gate is " +
			"gone and `visibility` is the whole public gate. The column is retained because the " +
			"admin listing and the creator dashboard display the stored row, but nothing decides " +
			"on it. Giving publish an 'active' writer was rejected: it would make `status` a second " +
			"encoding of `visibility`, and a second encoding drifts — #587 is exactly that.",
		decisions: {
			active:
				"NO WRITER, deliberately (#590, re-affirmed #598). `visibility` is the whole public " +
				"gate; a publish-time 'active' writer would make this column a second encoding of it, " +
				"and a second encoding drifts. The seed rows are DISPLAYED, never decided on.",
			error:
				"DEAD VOCABULARY (#598). Declared by 0001_init.sql and written by nothing, ever. Agent " +
				"failure is recorded per RUN — error_log, agent_events, pipeline_runs.status — not as a " +
				"state on the template row, so a writer would have to invent both the transition into " +
				"it and the one out of it, and every listing that shows agents would need to learn what " +
				"an errored template means. Not added. The word cannot be deleted (shipped migration " +
				"comment), so it is recorded here instead.",
		},
	},
	"agent_instances.status": {
		values: { active: "app", paused: "none", canceled: "app" },
		note: "'paused' is declared and displayed but no route writes it; cancel writes 'canceled'.",
		decisions: {
			paused:
				"MISSING CAPABILITY, not a dead word — and deliberately not built under #598, which is " +
				"a vocabulary ticket. What was checked for a design record: docs/ and docs/adr/ have " +
				"nothing on pausing an instance, and no closed issue does either. What DOES exist is a " +
				"read side already built for it: lib/trigger-eligibility.ts chose an ALLOWLIST over " +
				"`status != 'canceled'` precisely so that 'if pause ever acquires a writer, a paused " +
				"instance must not be running cron work, and with an allowlist it silently already does " +
				"not' (#649), and lib/subscription-standing.ts plus migration 0131 make the same " +
				"conservative choice from the other side. So the safety is in place and the FEATURE is " +
				"not: a writer, a console control, a resume path, and the admin instance filter (which " +
				"already offers 'paused' and can only ever return zero rows). Shipping the writer alone " +
				"is what makes a half-working control, which is the failure #664 named.",
		},
	},
	"subscriptions.status": {
		values: { active: "app", canceled: "app", past_due: "none" },
		note:
			"'past_due' is declared on this table and written NOWHERE. The only writes are the INSERT " +
			"in routes/instances.ts (subscribe → 'active') and two `SET status = 'canceled'` " +
			"(routes/instances.ts, routes/admin-moderation.ts). Stripe's past-due signal lands on " +
			"`users.subscription_status`, which is a different column on a different table — this one " +
			"tracks a marketplace subscription to an agent, not a payment state.",
		decisions: {
			past_due:
				"DEAD VALUE, and specifically NOT a billing gap (#598). PAGS billing being deferred is " +
				"not the reason: enabling it would not add a writer here. Stripe's dunning signal is " +
				"already wired, to users.subscription_status (lib/billing.ts writes the literal " +
				"'past_due' on invoice.payment_failed) — the PLATFORM subscription, one per user. THIS " +
				"table is a marketplace subscription to an agent, UNIQUE(agent_id, user_id); no payment " +
				"ever attaches to one, so 'past_due' has no meaning on it however billing is configured. " +
				"Migration 0131 enumerated every statement touching the table — one DDL, four writes, " +
				"two reads, neither projecting or predicating on status — so nothing reads it either.",
		},
	},
	"users.subscription_status": {
		values: { none: "app", active: "app", canceled: "app?", past_due: "app" },
		note:
			"'canceled' arrives as `sub.status` passed straight through from the Stripe webhook " +
			"(lib/billing.ts:258 and :266 bind a variable), so no literal appears at the write. " +
			"'active' and 'past_due' are written literally at lib/billing.ts:235 and :278; 'none' is " +
			"the column DEFAULT applied by the user INSERT.",
	},
	"instance_runtimes.status": {
		values: { registered: "app", online: "app", offline: "app" },
		note: "'registered' is the DEFAULT applied by the register route's INSERT; the other two come from `updateRuntimeStatus`.",
	},
	"instance_runtime_nodes.status": {
		values: { registered: "app", online: "app", offline: "app" },
		note:
			"Declared HERE rather than in migration 0047, which states no domain — and that silence " +
			"is part of why #570 took months to find. 'offline' had no writer at all until #587 made " +
			"the two probe call sites pass the node they actually probed; before that " +
			"`runner-client.ts`'s `status != 'offline'` routing gate could never exclude anything.",
	},
	"coding_sessions.status": {
		values: { active: "app", ended: "app", error: "app", suspended: "app" },
		note:
			"'suspended' is written by the multi-machine takeover path and is NOT in migration 0020's " +
			"comment — the schema comment went stale, which this table records rather than absorbs.",
	},
	"coding_repos.clone_status": {
		values: { unknown: "app?", cloning: "app?", ready: "app?", missing_url: "app?", error: "app?" },
		note:
			"Every write goes through one statement, `SET clone_status = COALESCE(?2, clone_status)` " +
			"(lib/coding-store.ts:226), bound from `patch.cloneStatus`. The literals are at the " +
			"callers — lib/coding-store.ts:169 picks ready/cloning/missing_url from what the repo " +
			"has, and `cloneStatusForVerdict` (lib/coding-workdir.ts) returns the rest from a " +
			"measurement. A single typed choke point is why the scanner cannot see them.",
	},
	"pipeline_runs.status": {
		values: { running: "app", completed: "app", failed: "app", interrupted: "app" },
	},
	"agent_loop_runs.status": {
		values: { running: "app", completed: "app?", failed: "app", needs_human: "app?", cancelled: "app?" },
		note:
			"`finishLoopRun` (lib/agent-loop-store.ts:341) is the only terminal write and binds its " +
			"`reason` argument; the three terminal values are decided by the workflows that call it " +
			"(workflows/agent-loop.ts:280, workflows/coding-session.ts:227). 'running' is the INSERT " +
			"literal at :156.",
	},
	"mcp_input_requests.status": {
		values: { pending: "app", answered: "app", cancelled: "app", expired: "app" },
	},
	"agent_feedback.status": {
		values: { open: "app?", triaged: "app?", filed: "app?", dismissed: "app?" },
		note:
			"The update builds its SET clause at runtime from a joined array (lib/feedback.ts:242), so the " +
			"column never appears literally in a statement. The domain is enforced in TypeScript " +
			"instead — `FeedbackStatus` and `FEEDBACK_STATUSES` (lib/feedback.ts:35, :40) — and " +
			"'open' is the value the insert path sets at :152.",
	},
	"agent_trigger_events.status": {
		values: { received: "app", running: "app", succeeded: "app", failed: "app" },
	},
	"delegation_budgets.status": {
		values: { open: "app", exhausted: "app", closed: "app" },
	},
};

/** Every declared value that application code cannot write, as `table.column = value`. */
export function unreachableValues(domains = STATUS_DOMAINS): string[] {
	const out: string[] = [];
	for (const [column, domain] of Object.entries(domains)) {
		for (const [value, provenance] of Object.entries(domain.values)) {
			if (!isWritable(provenance)) out.push(`${column} = ${value}`);
		}
	}
	return out.sort();
}
