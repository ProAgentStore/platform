// MCP management surface for worker-backed mail connections (#1277) — instance-scoped, owner-only.
//
// Everything here composes the services #1269/#1270 shipped; it adds no second way to store a credential. The one
// new capability is SECURE ENROLLMENT: the bridge secret is entered by the owner in the console's secure-input page,
// then consumed server-side by {@link completeEnrollment}. No route here accepts or returns a secret.
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { secureInputLink } from "../lib/console-links.js";
import { probeEmailWorkerIdentity } from "../lib/connectors/email-worker.js";
import { listConsents } from "../lib/connector-consent.js";
import { beginEnrollment, completeEnrollment, enrollmentView } from "../lib/email-worker-enrollment.js";
import {
	listEmailWorkerConnections,
	normalizeEmailWorkerEndpoint,
	pinnedEmailWorkerConnectionFrom,
	recordProbeFailure,
	recordProbeSuccess,
	resolveEmailWorkerConnectionFrom,
	resolveEmailWorkerSecret,
	updateEmailWorkerContractVersion,
} from "../lib/email-worker-connections.js";
import { loadProfile } from "../lib/email-worker-identities.js";
import { buildEmailWorkerStatus } from "../lib/email-worker-status.js";
import { logEvent } from "../lib/events.js";
import type { Env } from "../types.js";
import { requireOwnedInstance } from "./instances-runtime.js";

export const emailWorkerManageRoutes = new Hono<{ Bindings: Env }>();

function endpointOrThrow(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, "endpoint is required.");
	let normalized: string;
	try {
		normalized = normalizeEmailWorkerEndpoint(raw.trim());
	} catch {
		throw new HttpError(400, "endpoint must be a valid URL.");
	}
	if (!normalized.startsWith("https://")) throw new HttpError(400, "endpoint must be an https:// URL.");
	return normalized;
}

function configOf(raw: string | null | undefined): unknown {
	try {
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

/** GET /v1/instances/:id/email-worker/status — state, pin, identities, health, consent and every blocker, by name. */
emailWorkerManageRoutes.get("/:id/email-worker/status", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const connections = await listEmailWorkerConnections(c.env, session.uid, "https://api.proagentstore.online");
	const profiles = new Map(await Promise.all(connections.map(async (x) => [`${x.endpoint}\u0000${x.accountId}`, await loadProfile(c.env, session.uid, x.endpoint, x.accountId)] as const)));
	const consent = (await listConsents(c.env, instance.id)).find((r) => r.connector === "email-worker" && r.scope === "write");
	const pinned = pinnedEmailWorkerConnectionFrom(configOf(instance.config)) ?? null;
	const status = buildEmailWorkerStatus({ connections, profiles, pinned, writeConsent: consent ? (consent.mode === "ask" ? "ask" : "always") : "off" });
	// `?enrollment=<id>` folds in where one secure enrollment stands (metadata only), so one read answers "did the owner enter it yet?".
	const eid = c.req.query("enrollment");
	return c.json(eid ? { ...status, enrollment: await enrollmentView(c.env, session.uid, instance.id, eid) } : status);
});

/**
 * POST /v1/instances/:id/email-worker/enrollments { endpoint, accountId?, label? } — open a secure enrollment. Returns
 * the opaque handle and the console path where the OWNER types the bridge secret; the secret never comes back here.
 */
emailWorkerManageRoutes.post("/:id/email-worker/enrollments", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	if ("secret" in body) throw new HttpError(400, "Do not send the secret here — the owner enters it in the console via the returned link.");
	const endpoint = endpointOrThrow(body.endpoint);
	const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
	const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
	if (label && label.length > 120) throw new HttpError(400, "label must be at most 120 characters.");
	const { enrollmentId } = await beginEnrollment(c.env, { userId: session.uid, instanceId: instance.id, endpoint, accountId, label });
	await logEvent(c.env, { source: "email-worker", event: "email.enrollment.begun", level: "info", userId: session.uid, message: "Worker mail enrollment opened", context: { connector: "email-worker", endpoint, accountId, enrollmentId } }).catch(() => undefined);
	return c.json({ enrollmentId, endpoint, accountId, consoleUrl: secureInputLink(instance.id, enrollmentId), next: "Hand the owner consoleUrl. Once they have entered the secret, complete the enrollment." }, 201);
});

/** POST /v1/instances/:id/email-worker/enrollments/:eid/complete — consume the entered secret, test the bridge, store the connection. */
emailWorkerManageRoutes.post("/:id/email-worker/enrollments/:eid/complete", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const result = await completeEnrollment(c.env, session.uid, instance.id, c.req.param("eid"));
	if (!result.ok) return c.json({ ok: false, error: result.message, code: result.code, ...(result.failureClass ? { failureClass: result.failureClass } : {}) }, result.status);
	const view = await enrollmentView(c.env, session.uid, instance.id, c.req.param("eid"));
	await logEvent(c.env, { source: "email-worker", event: "email.enrollment.completed", level: "info", userId: session.uid, message: "Worker mail connection enrolled", context: { connector: "email-worker", enrollmentId: c.req.param("eid"), endpoint: view?.endpoint ?? "" } }).catch(() => undefined);
	return c.json({ ok: true, contractVersion: result.contractVersion, address: result.address, enrollment: view, next: "Pin it to the instance and approve the sender and reply identity." });
});

/**
 * POST /v1/instances/:id/email-worker/test { endpoint?, accountId? } — test the STORED credential of the connection this
 * instance resolves to (or the named one). Takes no secret: a value to try goes through enrollment. Records health.
 */
emailWorkerManageRoutes.post("/:id/email-worker/test", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	if ("secret" in body) throw new HttpError(400, "This test uses the stored credential and takes no secret.");
	const connections = await listEmailWorkerConnections(c.env, session.uid, "https://api.proagentstore.online");
	let endpoint: string;
	let accountId: string;
	if (typeof body.endpoint === "string" && body.endpoint.trim()) {
		endpoint = endpointOrThrow(body.endpoint);
		accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
	} else {
		const res = resolveEmailWorkerConnectionFrom(connections, pinnedEmailWorkerConnectionFrom(configOf(instance.config)));
		if (!res.ok) return c.json({ ok: false, code: res.reason, error: res.message }, 409);
		endpoint = res.endpoint;
		accountId = res.accountId;
	}
	const secret = await resolveEmailWorkerSecret(c.env, session.uid, endpoint, accountId);
	if (!secret) return c.json({ ok: false, code: "no_connection", error: "No stored connection for that endpoint/account." }, 404);
	const probe = await probeEmailWorkerIdentity(endpoint, secret);
	if (!probe.ok) {
		await recordProbeFailure(c.env, session.uid, endpoint, accountId, probe.failureClass);
		return c.json({ ok: false, code: "bridge_failure", failureClass: probe.failureClass, error: probe.error.split(secret).join("[redacted]") });
	}
	await updateEmailWorkerContractVersion(c.env, session.uid, endpoint, accountId, probe.contractVersion).catch(() => undefined);
	await recordProbeSuccess(c.env, session.uid, endpoint, accountId, probe.snapshot).catch(() => undefined);
	return c.json({ ok: true, endpoint, accountId, contractVersion: probe.contractVersion, address: probe.address, provider: probe.snapshot.provider });
});
