// Worker-backed email connector (#1269) — connection management (add/test/replace/revoke, AC1),
// per-instance pinning (which ONE connection an agent uses, mirroring Gmail's single-mailbox
// pin), and the public inbound delivery endpoint the owner's Worker calls back into.
//
// Credential posture: a secret is accepted here, tested against the adapter, encrypted and
// stored — and never returned. Every GET below is built from {@link EmailWorkerConnectionInfo},
// which carries no secret column at all, so "accidentally echo it back" is not a shape this file
// can produce.
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import { probeEmailWorkerIdentity } from "../lib/connectors/email-worker.js";
import {
	connectionForWebhookToken,
	deleteEmailWorkerConnection,
	listEmailWorkerConnections,
	normalizeEmailWorkerEndpoint,
	pinnedEmailWorkerConnectionFrom,
	recordInboundEventOnce,
	resolveEmailWorkerConnectionFrom,
	resolveEmailWorkerSecret,
	saveEmailWorkerConnection,
	updateEmailWorkerContractVersion,
} from "../lib/email-worker-connections.js";
import { logEvent } from "../lib/events.js";
import type { Env } from "../types.js";

export const emailWorkerRoutes = new Hono<{ Bindings: Env }>();
export const emailWorkerInstanceRoutes = new Hono<{ Bindings: Env }>();
/** Mounted unauthenticated, at the top level — the Worker's own inbound delivery callback. */
export const emailWorkerInboundRoutes = new Hono<{ Bindings: Env }>();

function publicOrigin(requestUrl: string): string {
	const url = new URL(requestUrl);
	if (url.hostname.includes("localhost") || url.hostname === "127.0.0.1") return url.origin;
	return "https://api.proagentstore.online";
}

function normalizedOrThrow(raw: unknown): string {
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

/** GET /v1/email-worker/connections — every worker-backed mail connection the owner holds. */
emailWorkerRoutes.get("/connections", async (c) => {
	const session = await requireUser(c);
	const connections = await listEmailWorkerConnections(c.env, session.uid, publicOrigin(c.req.url));
	return c.json({ connections });
});

/**
 * POST /v1/email-worker/connections — add OR REPLACE a connection (AC1).
 *
 * Always tests the secret against the adapter's `/v1/email-worker/identity` BEFORE storing it —
 * a connection that cannot even identify itself is not saved, so the console never shows a
 * "connected" state for a Worker that was never reachable.
 */
emailWorkerRoutes.post("/connections", async (c) => {
	const session = await requireUser(c);
	const body = await c.req.json().catch(() => ({}));
	const endpoint = normalizedOrThrow(body.endpoint);
	const secret = typeof body.secret === "string" ? body.secret.trim() : "";
	if (!secret) throw new HttpError(400, "secret is required.");
	const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
	const accountLabel = typeof body.label === "string" ? body.label.trim() : null;

	const probe = await probeEmailWorkerIdentity(endpoint, secret);
	if (!probe.ok) throw new HttpError(422, `Could not connect: ${probe.error}`);

	await saveEmailWorkerConnection(c.env, { userId: session.uid, endpoint, accountId, secret, accountLabel, contractVersion: probe.contractVersion });
	const connections = await listEmailWorkerConnections(c.env, session.uid, publicOrigin(c.req.url));
	const saved = connections.find((x) => x.endpoint === endpoint && x.accountId === accountId);
	return c.json({ success: true, contractVersion: probe.contractVersion, address: probe.address, connection: saved ?? null });
});

/**
 * POST /v1/email-worker/connections/test — the connector-test view's action (AC1/AC4). Re-probes
 * identity without changing anything by default; pass `secret` to test a value before saving it
 * (e.g. rotating a credential). Updates the recorded contractVersion on a successful probe of an
 * EXISTING connection, so the console shows what the Worker currently claims to speak.
 */
emailWorkerRoutes.post("/connections/test", async (c) => {
	const session = await requireUser(c);
	const body = await c.req.json().catch(() => ({}));
	const endpoint = normalizedOrThrow(body.endpoint);
	const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
	let secret = typeof body.secret === "string" ? body.secret.trim() : "";
	if (!secret) secret = (await resolveEmailWorkerSecret(c.env, session.uid, endpoint, accountId)) ?? "";
	if (!secret) throw new HttpError(404, "No connection (and no secret given) to test.");

	const probe = await probeEmailWorkerIdentity(endpoint, secret);
	if (probe.ok) await updateEmailWorkerContractVersion(c.env, session.uid, endpoint, accountId, probe.contractVersion).catch(() => undefined);
	return c.json(probe.ok ? { ok: true, contractVersion: probe.contractVersion, address: probe.address } : { ok: false, error: probe.error });
});

/** DELETE /v1/email-worker/connections?endpoint=&account= — revoke (AC1). */
emailWorkerRoutes.delete("/connections", async (c) => {
	const session = await requireUser(c);
	const endpoint = normalizedOrThrow(c.req.query("endpoint"));
	const accountId = c.req.query("account") ?? "";
	const removed = await deleteEmailWorkerConnection(c.env, session.uid, endpoint, accountId);
	return c.json({ success: true, removed });
});

/**
 * GET /v1/instances/:id/email-worker/account — this instance's pin + what it resolves to.
 * `resolved: null` with more than one connection is the ambiguous state a console renders as a
 * decision waiting, exactly like the generic `/connector-accounts` route does for Gmail.
 */
emailWorkerInstanceRoutes.get("/:id/email-worker/account", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const connections = await listEmailWorkerConnections(c.env, session.uid, publicOrigin(c.req.url));
	const pinned = pinnedEmailWorkerConnectionFrom(instance.config ? JSON.parse(instance.config) : {}) ?? null;
	const resolved = resolveEmailWorkerConnectionFrom(connections, pinned ?? undefined);
	return c.json({
		connections,
		pinned,
		resolved: resolved.ok ? { endpoint: resolved.endpoint, accountId: resolved.accountId, label: resolved.label } : null,
		blocked: resolved.ok ? null : { reason: resolved.reason, message: resolved.message },
	});
});

/**
 * PUT /v1/instances/:id/email-worker/account — pin this instance to one connection, or clear
 * with `{}`. Refused at write time when the named combination doesn't exist, same discipline as
 * the `/mcp/accounts` pin route — a pin to a connection that was never there is a mistake caught
 * now, not discovered the next time the agent tries to read its mail.
 */
emailWorkerInstanceRoutes.put("/:id/email-worker/account", async (c) => {
	const session = await requireUser(c);
	const instance = await requireOwnedInstance(c.env, c.req.param("id"), session.uid);
	const body = await c.req.json().catch(() => ({}));
	const endpointRaw = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
	if (!endpointRaw) {
		await patchInstanceConfig(c.env, instance.id, session.uid, "emailWorkerAccount", null);
		return c.json({ success: true, pinned: null });
	}
	const endpoint = normalizedOrThrow(endpointRaw);
	const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
	const connections = await listEmailWorkerConnections(c.env, session.uid, publicOrigin(c.req.url));
	if (!connections.some((x) => x.endpoint === endpoint && x.accountId === accountId)) {
		throw new HttpError(404, "No such worker-backed email connection to pin.");
	}
	await patchInstanceConfig(c.env, instance.id, session.uid, "emailWorkerAccount", { endpoint, accountId });
	return c.json({ success: true, pinned: { endpoint, accountId } });
});

/**
 * POST /v1/email-worker/inbound/:token — the owner's Worker calling PAGS back (AC2/AC5). The
 * token IS the authentication, exactly like `POST /v1/triggers/webhook/:token`: a capability URL
 * the owner pastes into their own Worker config, looked up directly with no further auth header.
 *
 * `eventId` dedupes a retried delivery (#1269 AC5) — the audit receipt and anything the inbound
 * event would otherwise trigger both happen at most once per `eventId`, however many times the
 * Worker resends it.
 */
emailWorkerInboundRoutes.post("/:token", async (c) => {
	const token = c.req.param("token");
	const conn = await connectionForWebhookToken(c.env, token);
	if (!conn) throw new HttpError(404, "Unknown inbound delivery token.");
	const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
	const type = typeof body.type === "string" ? body.type : "unknown";
	const eventId = typeof body.eventId === "string" && body.eventId.trim() ? body.eventId.trim() : null;
	if (!eventId) throw new HttpError(400, "eventId is required.");
	const messageId = typeof body.messageId === "string" ? body.messageId : undefined;
	const threadId = typeof body.threadId === "string" ? body.threadId : undefined;

	const isNew = await recordInboundEventOnce(c.env, conn.userId, conn.endpoint, conn.accountId, eventId);
	if (isNew) {
		await logEvent(c.env, {
			source: "email-worker",
			event: type === "message.received" ? "email.inbound" : "email.delivery",
			level: "info",
			userId: conn.userId,
			message: `${type} on ${conn.label}`,
			context: { connector: "email-worker", endpoint: conn.endpoint, accountId: conn.accountId, type, ...(messageId ? { messageId } : {}), ...(threadId ? { threadId } : {}), outcome: "ok" },
		}).catch(() => undefined);
	}
	return c.json({ ok: true, deduped: !isNew }, 202);
});
