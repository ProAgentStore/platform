/**
 * Application Tailor (#956) — settings and the application records it produces.
 *
 * Tailoring normally starts from a connection: the Scout's `job.lead.apply_requested` (#955)
 * routed to this instance with the `generate_application_materials` action. `POST …/applications`
 * is the same start path for an owner (or a test) holding the event; replaying either returns the
 * existing application. Reading an application pulls its run from the runner first (#944's PULL —
 * the runner cannot reach the API).
 *
 * Owner-scoped throughout; every store call is `user_id`-scoped as well. Responses carry artifact
 * HANDLES (owner-visible path + sha256), never résumé or profile content.
 */
import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { readInstanceConfigPair, patchInstanceConfig } from "../lib/instance-config.js";
import { cancelTailoring, startTailoring, syncTailorRun } from "../lib/local-artifact/tailor.js";
import {
	type ApplicationStatus,
	TAILOR_DEFAULTS,
	TAILOR_SETTINGS_KEY,
	effectiveTailorSettings,
	getApplication,
	getTailorRun,
	listApplications,
	mergeTailorSettings,
} from "../lib/local-artifact/store.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

type C = Context<{ Bindings: Env }>;

async function owned(c: C): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return { uid: session.uid, instanceId };
}

const STATUSES: readonly ApplicationStatus[] = ["tailoring", "materials_ready", "blocked", "failed", "cancelled"];

async function storedSettings(c: C, instanceId: string, uid: string): Promise<unknown> {
	const pair = await readInstanceConfigPair(c.env, instanceId, uid);
	return (pair?.config as Record<string, unknown> | undefined)?.[TAILOR_SETTINGS_KEY];
}

export function registerApplicationTailorRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/application-tailor/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const effective = effectiveTailorSettings(await storedSettings(c, instanceId, uid));
		return c.json("error" in effective ? { settings: TAILOR_DEFAULTS, error: effective.error } : { settings: effective.settings });
	});

	/** Patch semantics: only the fields sent change; a source set to null/"" is removed. */
	router.put("/:instanceId/application-tailor/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const current = effectiveTailorSettings(await storedSettings(c, instanceId, uid));
		const merged = mergeTailorSettings("error" in current ? TAILOR_DEFAULTS : current.settings, await c.req.json().catch(() => null));
		if ("error" in merged) return c.json({ error: merged.error }, 400);
		await patchInstanceConfig(c.env, instanceId, uid, TAILOR_SETTINGS_KEY, merged.settings);
		return c.json({ settings: merged.settings });
	});

	router.get("/:instanceId/applications", async (c) => {
		const { uid, instanceId } = await owned(c);
		const status = c.req.query("status");
		if (status && !STATUSES.includes(status as ApplicationStatus)) return c.json({ error: `status must be one of ${STATUSES.join(", ")}` }, 400);
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
		const applications = await listApplications(c.env, instanceId, uid, { status: status as ApplicationStatus | undefined, limit });
		return c.json({ applications, limit, ...(applications.length === limit ? { note: `Showing the newest ${limit}; pass ?limit= (max 200) or ?status= to see others.` } : {}) });
	});

	/** Start tailoring from an approved lead event — `{ event }`, or the event itself as the body. */
	router.post("/:instanceId/applications", async (c) => {
		const { uid, instanceId } = await owned(c);
		const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
		const event = body && typeof body.event === "object" ? body.event : body;
		const out = await startTailoring(c.env, instanceId, uid, event, "owner");
		return c.json({ outcome: out.kind, application: out.application, run: out.run }, out.kind === "existing" ? 200 : 201);
	});

	router.get("/:instanceId/applications/:applicationId", async (c) => {
		const { uid, instanceId } = await owned(c);
		let application = await getApplication(c.env, instanceId, uid, c.req.param("applicationId"));
		if (!application) throw new HttpError(404, "Application not found");
		let run = application.tailoringRunId ? await getTailorRun(c.env, instanceId, uid, application.tailoringRunId) : null;
		if (run?.status === "running") {
			run = await syncTailorRun(c.env, uid, run);
			application = (await getApplication(c.env, instanceId, uid, application.id)) ?? application;
		}
		return c.json({ application, run });
	});

	/** Stop tailoring. Touches PAGS records and the local CLI only — nothing external. */
	router.post("/:instanceId/applications/:applicationId/cancel", async (c) => {
		const { uid, instanceId } = await owned(c);
		const application = await getApplication(c.env, instanceId, uid, c.req.param("applicationId"));
		if (!application) throw new HttpError(404, "Application not found");
		const run = application.tailoringRunId ? await getTailorRun(c.env, instanceId, uid, application.tailoringRunId) : null;
		if (!run) throw new HttpError(409, `Nothing to cancel: the application is ${application.status}`);
		const cancelled = await cancelTailoring(c.env, uid, run);
		return c.json({ application: await getApplication(c.env, instanceId, uid, application.id), run: cancelled });
	});
}
