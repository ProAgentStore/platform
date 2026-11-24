// GET /v1/inbox — everything waiting on the owner, across every instance (#1640). Aggregation only: see lib/inbox.ts.
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { INBOX_KINDS, INBOX_SORTS, INBOX_URGENCIES, applyInboxQuery, countInbox, inboxCounts, readInbox, type InboxKind, type InboxSort, type InboxUrgency } from "../lib/inbox.js";
import { TRIAGE_STATUSES, isTriageItem, writeTriage, type TriagePatch, type TriageStatus } from "../lib/inbox-triage.js";
import type { Env } from "../types.js";

export const inboxRoutes = new Hono<{ Bindings: Env }>();

/** Repeated (`kind=a&kind=b`) or comma-separated (`kind=a,b`) values, so MCP and the console both fit. */
const multi = (values: string[]): string[] => values.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
const oneOf = <T extends string>(allowed: readonly T[], v: string | undefined): T | null => (v && (allowed as readonly string[]).includes(v) ? (v as T) : null);

/** GET /v1/inbox/count — the nav badge: COUNT(*) per source over partial indexes, no rows read. `partial` = a source failed. */
inboxRoutes.get("/inbox/count", async (c) => {
	const session = await requireUser(c);
	return c.json(await countInbox(c.env, session.uid));
});

/**
 * GET /v1/inbox?kind=&instance=&agent=&urgency=&sort=newest|oldest|urgency|expiring&triage=new|discussed|deferred|all&needs_computer=1&limit=
 * `counts` describe the whole waiting set, not the filtered view. `sources` reports every source's read, so a failed one is never "nothing waiting".
 */
inboxRoutes.get("/inbox", async (c) => {
	const session = await requireUser(c);
	const kinds = multi(c.req.queries("kind") ?? []).filter((k): k is InboxKind => (INBOX_KINDS as readonly string[]).includes(k));
	const { items, sources } = await readInbox(c.env, session.uid);
	const query = {
		kinds,
		instances: multi(c.req.queries("instance") ?? []),
		agent: c.req.query("agent") || null,
		urgency: oneOf<InboxUrgency>(INBOX_URGENCIES, c.req.query("urgency")),
		sort: oneOf<InboxSort>(INBOX_SORTS, c.req.query("sort")) ?? "urgency",
		triage: oneOf<TriageStatus | "all" | "review">([...TRIAGE_STATUSES, "all", "review"], c.req.query("triage")) ?? undefined,
		needsComputer: ["1", "true"].includes(c.req.query("needs_computer") ?? ""),
	};
	const shown = applyInboxQuery(items, query);
	const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 200));
	return c.json({
		asOf: Date.now(),
		items: shown.slice(0, limit),
		total: shown.length,
		counts: inboxCounts(items),
		sources,
		complete: sources.every((s) => s.ok && !s.truncated),
	});
});

/**
 * PUT /v1/inbox/triage { item_id, status?, needs_computer?, defer_until? } (#1697) — the owner's own bookkeeping on a coder question or parked
 * run. It answers, resumes, expires and hides nothing; the item must be one currently waiting on THIS user, so another owner's id is a 404.
 */
inboxRoutes.put("/inbox/triage", async (c) => {
	const session = await requireUser(c);
	const body = await c.req.json<{ item_id?: unknown; status?: unknown; needs_computer?: unknown; defer_until?: unknown }>().catch(() => null);
	const itemId = typeof body?.item_id === "string" ? body.item_id : "";
	if (!body || !isTriageItem(itemId)) return c.json({ error: "item_id must be a coder_question:<id> or run_parked:<id> item from the inbox" }, 400);
	const patch: TriagePatch = {};
	if (body.status !== undefined) {
		if (typeof body.status !== "string" || !(TRIAGE_STATUSES as readonly string[]).includes(body.status)) return c.json({ error: `status must be one of ${TRIAGE_STATUSES.join(", ")}` }, 400);
		patch.status = body.status as TriageStatus;
	}
	if (body.needs_computer !== undefined) {
		if (typeof body.needs_computer !== "boolean") return c.json({ error: "needs_computer must be a boolean" }, 400);
		patch.needsComputer = body.needs_computer;
	}
	const now = Date.now();
	if (body.defer_until !== undefined && body.defer_until !== null) {
		const ms = typeof body.defer_until === "string" ? Date.parse(body.defer_until) : Number.NaN;
		if (!Number.isFinite(ms) || ms <= now) return c.json({ error: "defer_until must be a future ISO date" }, 400);
		if (patch.status !== undefined && patch.status !== "deferred") return c.json({ error: "defer_until only applies to status deferred" }, 400);
		patch.status ??= "deferred";
		patch.deferUntil = ms;
	} else if (body.defer_until === null) patch.deferUntil = null;
	if (!Object.keys(patch).length) return c.json({ error: "nothing to change" }, 400);
	const { items } = await readInbox(c.env, session.uid, now);
	if (!items.some((it) => it.id === itemId)) return c.json({ error: "That item is not waiting on you" }, 404);
	return c.json({ itemId, triage: await writeTriage(c.env, session.uid, itemId, patch, now) });
});
