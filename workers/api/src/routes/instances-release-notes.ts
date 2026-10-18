/**
 * An instance's release-notes setting (#1217) and its test send.
 *
 *   GET  /v1/instances/:id/release-notes        the stored setting, the account default, and the
 *                                                resolved effect: on/off, and each granted channel
 *                                                marked whether it receives the notes
 *   PUT  /v1/instances/:id/release-notes        `{ enabled?: boolean|null, channels?: string[]|null }`,
 *                                                patch per field; `null` returns a field to inherited
 *   POST /v1/instances/:id/release-notes/test   `{ grantId }` — post a test note to one granted channel
 *
 * The account default is `releaseNotes` in `PUT /v1/preferences`. Resolution and validation live in
 * lib/release-notes-settings.ts, shared with the run-end delivery so the two cannot disagree.
 */
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import { sendTestReleaseNote } from "../lib/release-notes.js";
import { applyInstanceReleaseNotesPatch, loadReleaseNotes } from "../lib/release-notes-settings.js";
import type { InstanceReleaseNotesResponse, ReleaseNoteTestResponse } from "../agent-types.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const instanceReleaseNotesRoutes = new Hono<{ Bindings: Env }>();

async function view(env: Env, instanceId: string, userId: string): Promise<InstanceReleaseNotesResponse> {
	const loaded = await loadReleaseNotes(env, instanceId, userId);
	if (!loaded) throw new HttpError(404, "Instance not found");
	return { settings: loaded.instance, account: loaded.account ?? null, effective: loaded.effective };
}

instanceReleaseNotesRoutes.get("/:id/release-notes", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	return c.json(await view(c.env, instance.id, session.uid));
});

instanceReleaseNotesRoutes.put("/:id/release-notes", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const current = await view(c.env, instance.id, session.uid);
	const body = await c.req.json().catch(() => null);
	const next = applyInstanceReleaseNotesPatch(current.settings, body, current.effective.channels);
	await patchInstanceConfig(c.env, instance.id, session.uid, "releaseNotes", next);
	return c.json(await view(c.env, instance.id, session.uid));
});

instanceReleaseNotesRoutes.post("/:id/release-notes/test", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
	const extra = Object.keys(body).filter((k) => k !== "grantId");
	if (extra.length) throw new HttpError(400, `Unknown field ${extra.map((k) => `\`${k}\``).join(", ")} — the only field is \`grantId\`.`);
	if (typeof body.grantId !== "string" || !body.grantId) throw new HttpError(400, "grantId is required: a channel grant id from GET /v1/instances/:id/release-notes.");
	return c.json((await sendTestReleaseNote(c.env, session.uid, instance.id, body.grantId)) satisfies ReleaseNoteTestResponse);
});
