// GET /v1/inbox — everything waiting on the owner, across every instance (#1640). Aggregation only: see lib/inbox.ts.
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { INBOX_KINDS, INBOX_SORTS, INBOX_URGENCIES, applyInboxQuery, countInbox, inboxCounts, readInbox, type InboxKind, type InboxSort, type InboxUrgency } from "../lib/inbox.js";
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
 * GET /v1/inbox?kind=&instance=&agent=&urgency=&sort=newest|oldest|urgency|expiring&limit=
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
