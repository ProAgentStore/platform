import type { Env } from "../types.js";
import { CHARGED_SQL } from "./usage-payer.js";

/**
 * How much of the platform's usage comes from someone who is NOT the operator (#68).
 *
 * The focus bet is stated in terms of "0 external users" and "10 external users on one agent",
 * and the catalog audits, the browser epics and the whole third-party programme are all
 * prioritised against it — but nothing could measure it. `/v1/usage` is per-account: it answers
 * "what did I spend", never "is anyone else here". So the number the roadmap turns on was an
 * assumption, and it stayed one long enough to go badly stale: #68 records $0.86 of lifetime
 * spend on one agent, against $40.44 across twelve when finally measured.
 *
 * This makes the bet falsifiable. That is the whole point — a goal nobody can check is a mood.
 */

/**
 * Who counts as the operator.
 *
 * An ADMIN. Deliberately not "the owner of the first-party agents" and not a hardcoded id: the
 * seeded catalog agents are all owned by one account, so owner-based classification would count
 * a genuine external subscriber's usage of `coder` as operator usage and permanently read zero.
 *
 * `users.roles` is the live source (the same one `isAdmin` consults), plus `ADMIN_ALLOWLIST`,
 * so promoting or demoting someone is reflected immediately rather than at token expiry.
 *
 * The read selects `id, roles, github_login` and NOT an email. `users` has no email column and
 * never has: identity here is a GitHub or Google login, and the profile fields migration 0016
 * added went to `user_profile`. This function shipped selecting one anyway (#438) — D1 answered
 * `no such column: email` on every call, the `catch` below swallowed it, and the whole
 * roles-and-allowlist branch never ran once. What was left was the caller, which is exactly the
 * "identified NOBODY" symptom the comment below attributes to the token-only case, so the number
 * the focus bet turns on was measured through a query that always threw. `isAdmin` matches on
 * `id` and `github_login` for the same reason; an email in ADMIN_ALLOWLIST matches neither.
 */
export async function operatorUserIds(env: Env, callerUid?: string): Promise<Set<string>> {
	const ids = new Set<string>();
	// The CALLER, when this is reached through requireAdmin — which has already proven they are
	// an admin. `isAdmin` accepts three sources and one of them, the role baked into the session
	// token, is only observable for the person holding it: it cannot be queried for other users.
	// So a deployment whose operator has the role only in their token would identify NOBODY,
	// flag operatorUnknown, and count the operator's own 2782 calls as external — which is what
	// happened on the first real call to this endpoint.
	if (callerUid) ids.add(callerUid);
	const allow = (env.ADMIN_ALLOWLIST || "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	try {
		const { results } = await env.DB.prepare("SELECT id, roles, github_login FROM users").all<{
			id: string;
			roles: string | null;
			github_login: string | null;
		}>();
		for (const u of results ?? []) {
			let isAdminRole = false;
			try {
				isAdminRole = !!u.roles && (JSON.parse(u.roles) as string[]).includes("admin");
			} catch {
				/* malformed roles → not admin */
			}
			const listed =
				allow.includes(u.id.toLowerCase()) || (!!u.github_login && allow.includes(u.github_login.toLowerCase()));
			if (isAdminRole || listed) ids.add(u.id);
		}
	} catch {
		/* no users table access → treat nobody as operator; see the note in externalUsage */
	}
	return ids;
}

export interface UsageActor {
	userId: string;
	calls: number;
	valueMicros: number;
	chargedMicros: number;
	agents: string[];
}

/**
 * The two dollar figures this report carries, never one (#346).
 *
 * `valueMicros` is what the usage WOULD have cost at list prices, on every row without exception.
 * `chargedMicros` is the subset someone is actually charged for — {@link CHARGED_SQL}, i.e. a
 * `payer` of `byok-api` or `platform`. Work an engine did on somebody's Claude subscription has a
 * large value and a charge of zero.
 *
 * Both are reported because this report answers two questions that are about to be asked by two
 * different features. "Is anyone but the operator here?" (#68) wants VALUE: filtering it to
 * charged rows would make a subscription-heavy external user read as no user at all, which is
 * exactly the direction of error #343 was. "What is owed, and to whom?" (#57 metering → creator
 * payouts, #56 cost governance) wants CHARGED, and nothing else — paying a creator, or billing a
 * tenant, out of value drawn from somebody's own subscription is money invented from a list price.
 *
 * They are separate fields rather than one number and a flag so that a consumer has to name which
 * one it means. Until this split, this file did not mention `payer` at all, and whoever wired the
 * payout up would have inherited an unfiltered sum under an innocent name.
 */
export interface UsageTotals {
	calls: number;
	/** Notional list-price value of everything counted. Not a bill. */
	valueMicros: number;
	/** The subset of `valueMicros` that is money someone owes. THIS is the payout/billing input. */
	chargedMicros: number;
}

export interface ExternalUsageReport {
	/** The metric #68 is written in terms of. */
	externalUsers: number;
	/** Distinct external users per agent — "10 external users on ONE agent" is per-agent. */
	byAgent: Array<{ agentId: string; externalUsers: number } & UsageTotals>;
	totals: UsageTotals;
	/** Operator activity, reported alongside so the comparison is visible rather than implied. */
	operator: { users: number } & UsageTotals;
	/**
	 * True when NO operator could be identified. The counts are then meaningless rather than
	 * zero — every row looks external — so a caller must say "unknown", not "we have users".
	 * Reporting a falsely encouraging number is the one failure mode this whole thing exists
	 * to prevent.
	 */
	operatorUnknown: boolean;
}

/** Split usage rows into operator vs external. Pure — the SQL and the classification stay apart
 *  so the definition of "external" is testable without a database. */
export function splitUsage(
	rows: Array<{ user_id: string; agent_id: string | null; calls: number; value_micros: number; charged_micros: number }>,
	operators: ReadonlySet<string>,
): ExternalUsageReport {
	const external = rows.filter((r) => !operators.has(r.user_id));
	const operatorRows = rows.filter((r) => operators.has(r.user_id));

	const perAgent = new Map<string, { users: Set<string> } & UsageTotals>();
	for (const r of external) {
		// Rows with no agent id are real usage but cannot be attributed; they still count toward
		// the user total and are grouped under "(unattributed)" rather than silently dropped.
		const key = r.agent_id ?? "(unattributed)";
		const e = perAgent.get(key) ?? { users: new Set<string>(), calls: 0, valueMicros: 0, chargedMicros: 0 };
		e.users.add(r.user_id);
		e.calls += r.calls;
		e.valueMicros += r.value_micros;
		e.chargedMicros += r.charged_micros;
		perAgent.set(key, e);
	}

	const sum = (xs: typeof rows): UsageTotals => ({
		calls: xs.reduce((n, r) => n + r.calls, 0),
		valueMicros: xs.reduce((n, r) => n + r.value_micros, 0),
		chargedMicros: xs.reduce((n, r) => n + r.charged_micros, 0),
	});

	return {
		externalUsers: new Set(external.map((r) => r.user_id)).size,
		byAgent: [...perAgent.entries()]
			.map(([agentId, e]) => ({ agentId, externalUsers: e.users.size, calls: e.calls, valueMicros: e.valueMicros, chargedMicros: e.chargedMicros }))
			.sort((a, b) => b.externalUsers - a.externalUsers || b.calls - a.calls),
		totals: sum(external),
		operator: { users: new Set(operatorRows.map((r) => r.user_id)).size, ...sum(operatorRows) },
		operatorUnknown: operators.size === 0,
	};
}

/** The report over a time window, in days. */
export async function externalUsage(env: Env, days = 30, callerUid?: string): Promise<ExternalUsageReport> {
	const operators = await operatorUserIds(env, callerUid);
	const since = new Date(Date.now() - Math.max(1, Math.min(365, days)) * 86_400_000)
		.toISOString()
		.replace("T", " ")
		.slice(0, 19);
	const { results } = await env.DB.prepare(
		`SELECT user_id, agent_id, COUNT(*) AS calls,
		        COALESCE(SUM(cost_micros), 0) AS value_micros,
		        COALESCE(SUM(CASE WHEN ${CHARGED_SQL} THEN cost_micros ELSE 0 END), 0) AS charged_micros
		   FROM ai_usage
		  WHERE created_at >= ?1
		  GROUP BY user_id, agent_id`,
	)
		.bind(since)
		.all<{ user_id: string; agent_id: string | null; calls: number; value_micros: number; charged_micros: number }>();
	return splitUsage(results ?? [], operators);
}
