/**
 * `GET /v1/instances/my/coding-history` (#1335): the owner's coding history across EVERY instance in one filterable, pageable read —
 * picker decisions, attempts, runs, refused requests — with a full-range summary and an explicit statement of what is not recorded.
 *
 * Read-only. It writes nothing, replays nothing, requeues nothing. The read model is `lib/fleet-coding-history.ts`; this handler
 * only validates the query. A malformed filter is a 400 that names it — never a silent first page or an unfiltered answer.
 */
import type { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { FLEET_HISTORY_PAGE_MAX, FLEET_KINDS, FLEET_OUTCOMES, type FleetFilter, type FleetKind, type FleetOutcome, listFleetHistory } from "../lib/fleet-coding-history.js";
import { cursorParam } from "../lib/keyset-cursor.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** A time filter as ms epoch: digits are milliseconds, anything else must parse as a date. */
function timeParam(raw: string | undefined, name: string): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const ms = /^\d{1,16}$/.test(raw) ? Number(raw) : Date.parse(raw);
	if (!Number.isFinite(ms) || ms < 0) throw new HttpError(400, `${name} must be an ISO date or a millisecond epoch`);
	return ms;
}

export function registerFleetHistoryRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/my/coding-history", async (c) => {
		const session = await requireUser(c);
		const q = (name: string) => c.req.query(name);
		const filter: FleetFilter = { userId: session.uid };

		const instanceId = q("instance_id");
		if (instanceId) {
			await requireOwnedInstance(c.env, instanceId, session.uid);
			filter.instanceId = instanceId;
		}
		const repo = q("repo");
		if (repo) {
			if (!REPO.test(repo)) throw new HttpError(400, "repo must be owner/name");
			filter.repo = repo;
		}
		const issue = q("issue");
		if (issue !== undefined && issue !== "") {
			if (!/^\d{1,9}$/.test(issue) || Number(issue) < 1) throw new HttpError(400, "issue must be a positive issue number");
			filter.issue = Number(issue);
		}
		filter.since = timeParam(q("since"), "since");
		filter.until = timeParam(q("until"), "until");
		if (filter.since !== undefined && filter.until !== undefined && filter.since > filter.until) throw new HttpError(400, "since must not be after until");
		const outcome = q("outcome");
		if (outcome) {
			if (!(FLEET_OUTCOMES as readonly string[]).includes(outcome)) throw new HttpError(400, `outcome must be one of ${FLEET_OUTCOMES.join(", ")}`);
			filter.outcome = outcome as FleetOutcome;
		}
		const kind = q("kind");
		if (kind) {
			if (!(FLEET_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${FLEET_KINDS.join(", ")}`);
			filter.kind = kind as FleetKind;
		}
		const limitRaw = q("limit");
		if (limitRaw !== undefined && limitRaw !== "" && (!/^\d{1,4}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > FLEET_HISTORY_PAGE_MAX)) {
			throw new HttpError(400, `limit must be 1-${FLEET_HISTORY_PAGE_MAX}`);
		}
		const summary = q("summary");
		if (summary !== undefined && !["0", "1", "true", "false"].includes(summary)) throw new HttpError(400, "summary must be true or false");

		return c.json(
			await listFleetHistory(c.env, filter, {
				cursor: cursorParam(q("cursor"), "cursor"),
				limit: limitRaw ? Number(limitRaw) : undefined,
				summary: summary === undefined || summary === "1" || summary === "true",
			}),
		);
	});
}
