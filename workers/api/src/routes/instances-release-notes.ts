/**
 * An instance's release-notes setting (#1217) and its test send.
 *
 *   GET  /v1/instances/:id/release-notes        the stored setting, the account default, and the
 *                                                resolved effect: on/off, and each granted channel
 *                                                marked whether it receives the notes
 *   PUT  /v1/instances/:id/release-notes        `{ enabled?: boolean|null, channels?: string[]|null, requiredWorkflows? }`,
 *                                                patch per field; `null` returns a field to inherited.
 *                                                Both answer `gate`: none | ready | configuration_required (#1346)
 *   POST /v1/instances/:id/release-notes/test   `{ grantId }` — post a test note to one granted channel
 *   GET  /v1/instances/:id/release-notes/deliveries                       the queued/sent/failed notes, newest first,
 *                                                                          keyset-paged (`?cursor=&limit=`), with state,
 *                                                                          evidence, permalink and attempt history (#1348)
 *   POST /v1/instances/:id/release-notes/deliveries/:deliveryId/retry      `{ idempotencyKey? }` — a FAILED send, once
 *   POST /v1/instances/:id/release-notes/deliveries/:deliveryId/reconcile  `{ action, permalink?, confirm?, channelChecked? }`
 *                                                                          — an UNCERTAIN send: mark delivered, abandon, or send once more
 *
 * Coding agents only (#1286): any other instance answers 422 on all of them. The account default is `releaseNotes` in `PUT /v1/preferences`. Resolution and validation live in
 * lib/release-notes-settings.ts, shared with the run-end delivery so the two cannot disagree.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import { parseHistoryCursor } from "../lib/history-page.js";
import { listDeliveries, reconcileDelivery, retryDelivery } from "../lib/release-note-deliveries.js";
import { requireReleaseNotesEligible } from "../lib/release-notes-eligibility.js";
import { sendTestReleaseNote } from "../lib/release-notes.js";
import { applyInstanceReleaseNotesPatch, loadReleaseNotes, releaseGateState } from "../lib/release-notes-settings.js";
import type { InstanceReleaseNotesResponse, ReleaseNoteTestResponse } from "../agent-types.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const instanceReleaseNotesRoutes = new Hono<{ Bindings: Env }>();

async function view(env: Env, instanceId: string, userId: string): Promise<InstanceReleaseNotesResponse> {
	const loaded = await loadReleaseNotes(env, instanceId, userId);
	if (!loaded) throw new HttpError(404, "Instance not found");
	return { settings: loaded.instance, account: loaded.account ?? null, effective: loaded.effective, gate: releaseGateState(loaded.instance.requiredWorkflows) };
}

instanceReleaseNotesRoutes.get("/:id/release-notes", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	await requireReleaseNotesEligible(c.env, instance.id, session.uid);
	return c.json(await view(c.env, instance.id, session.uid));
});

instanceReleaseNotesRoutes.put("/:id/release-notes", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	await requireReleaseNotesEligible(c.env, instance.id, session.uid);
	const current = await view(c.env, instance.id, session.uid);
	const body = await c.req.json().catch(() => null);
	const next = applyInstanceReleaseNotesPatch(current.settings, body, current.effective.channels);
	await patchInstanceConfig(c.env, instance.id, session.uid, "releaseNotes", next);
	return c.json(await view(c.env, instance.id, session.uid));
});

instanceReleaseNotesRoutes.post("/:id/release-notes/test", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	await requireReleaseNotesEligible(c.env, instance.id, session.uid);
	const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
	const extra = Object.keys(body).filter((k) => k !== "grantId");
	if (extra.length) throw new HttpError(400, `Unknown field ${extra.map((k) => `\`${k}\``).join(", ")} — the only field is \`grantId\`.`);
	if (typeof body.grantId !== "string" || !body.grantId) throw new HttpError(400, "grantId is required: a channel grant id from GET /v1/instances/:id/release-notes.");
	return c.json((await sendTestReleaseNote(c.env, session.uid, instance.id, body.grantId)) satisfies ReleaseNoteTestResponse);
});

/** A body that names only the fields a route takes; anything else is refused, never dropped. */
async function strictBody(c: { req: { json: () => Promise<unknown> } }, allowed: readonly string[]): Promise<Record<string, unknown>> {
	const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
	if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object.");
	const extra = Object.keys(body).filter((k) => !allowed.includes(k));
	if (extra.length) throw new HttpError(400, `Unknown field ${extra.map((k) => `\`${k}\``).join(", ")} — the fields are ${allowed.map((k) => `\`${k}\``).join(", ")}.`);
	return body;
}

instanceReleaseNotesRoutes.get("/:id/release-notes/deliveries", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	await requireReleaseNotesEligible(c.env, instance.id, session.uid);
	const cursor = parseHistoryCursor(c.req.query("cursor") ?? "", "number");
	if (cursor.kind === "invalid") throw new HttpError(400, 'cursor is not one this endpoint issued — pass "newest" or a previous nextCursor');
	const rawLimit = c.req.query("limit");
	if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) throw new HttpError(400, "limit must be a whole number");
	return c.json(await listDeliveries(c.env, session.uid, instance.id, cursor, rawLimit === undefined ? undefined : Number(rawLimit)));
});

instanceReleaseNotesRoutes.post("/:id/release-notes/deliveries/:deliveryId/retry", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	await requireReleaseNotesEligible(c.env, instance.id, session.uid);
	return c.json(await retryDelivery(c.env, session.uid, instance.id, c.req.param("deliveryId"), await strictBody(c, ["idempotencyKey"])));
});

instanceReleaseNotesRoutes.post("/:id/release-notes/deliveries/:deliveryId/reconcile", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	await requireReleaseNotesEligible(c.env, instance.id, session.uid);
	return c.json(await reconcileDelivery(c.env, session.uid, instance.id, c.req.param("deliveryId"), await strictBody(c, ["action", "permalink", "confirm", "channelChecked", "idempotencyKey"])));
});
