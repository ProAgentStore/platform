/** Owner-authenticated website questions and remembered exact-host decisions (#1480). */
import type { Hono } from "hono";
import type { WebsiteGrantsResponse } from "../lib/website-access-response-types.js";
import type { Env } from "../types.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import { answerWebsiteAccessRequest, getWebsiteAccessRequest, listWebsiteAccessRequests, listWebsiteDomainDecisions, revokeWebsiteDomain, type WebsiteAccessAnswerAdapters } from "../lib/website-access.js";
import { websiteAccessResumeAdapters } from "../lib/website-access-resume.js";

export function registerWebsiteAccessRoutes(router: Hono<{ Bindings: Env }>, adaptersFor: (env: Env, uid: string, instanceId: string) => WebsiteAccessAnswerAdapters = websiteAccessResumeAdapters): void {
	router.get("/:instanceId/website-requests", async (c) => {
		const { uid } = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, uid);
		return c.json(await listWebsiteAccessRequests(c.env, uid, instanceId, c.req.query("cursor")));
	});
	router.get("/:instanceId/website-requests/:requestId", async (c) => {
		const { uid } = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, uid);
		const request = await getWebsiteAccessRequest(c.env, uid, instanceId, c.req.param("requestId"));
		if (!request) throw new HttpError(404, "Website request not found");
		return c.json({ request });
	});
	router.post("/:instanceId/website-requests/:requestId/answer", async (c) => {
		const { uid } = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, uid);
		const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
		if (!body || Object.keys(body).some((key) => key !== "decision") || (body.decision !== "approve" && body.decision !== "deny")) throw new HttpError(400, "Send only decision: approve or deny. The question already binds its agent, hostname and originating run.");
		return c.json(await answerWebsiteAccessRequest(c.env, uid, instanceId, c.req.param("requestId"), body.decision, adaptersFor(c.env, uid, instanceId)));
	});
	router.get("/:instanceId/website-grants", async (c) => {
		const { uid } = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, uid);
		const decisions = await listWebsiteDomainDecisions(c.env, uid, instanceId);
		return c.json({ domains: decisions.filter((d) => d.decision === "allow").map((d) => d.hostname), decisions } satisfies WebsiteGrantsResponse);
	});
	router.delete("/:instanceId/website-grants/:hostname", async (c) => {
		const { uid } = await requireUser(c);
		const instanceId = c.req.param("instanceId");
		await requireOwnedInstance(c.env, instanceId, uid);
		await revokeWebsiteDomain(c.env, uid, instanceId, c.req.param("hostname"));
		return c.json({ revoked: true, hostname: c.req.param("hostname") });
	});
}
