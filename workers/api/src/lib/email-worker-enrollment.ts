// Secure enrollment of a worker-backed mail connection (#1277).
//
// MCP can manage the connection but must never carry its bridge secret. The owner types the secret into the
// console's existing secure-input page (envelope-encrypted, one-shot); this module binds that request to the one
// endpoint/account the owner was shown, and — only when asked to complete — consumes it server-side, probes the
// bridge with it and stores it exactly as `POST /v1/email-worker/connections` does. The secret is a local variable
// inside {@link completeEnrollment}: it is not returned, logged, or put in an error message.
import { type Env } from "../types.js";
import { probeEmailWorkerIdentity } from "./connectors/email-worker.js";
import { recordProbeSuccess, saveEmailWorkerConnection } from "./email-worker-connections.js";
import { createSecureInputRequest, EMAIL_WORKER_ENROLL_PURPOSE, consumeSecureInput, getSecureInputStatus, restoreConsumedSecureInput } from "./secure-input.js";

export interface EnrollmentRow {
	id: string;
	user_id: string;
	instance_id: string;
	endpoint: string;
	account_id: string;
	account_label: string | null;
	outcome: string | null;
	failure_class: string | null;
	created_at: string;
	completed_at: string | null;
}

export interface EnrollmentView {
	enrollmentId: string;
	endpoint: string;
	accountId: string;
	label: string | null;
	/** pending = waiting for the owner; ready = the owner has entered it, not yet completed; connected / probe_failed = terminal-ish; expired. */
	state: "pending" | "ready" | "connected" | "probe_failed" | "expired" | "consumed";
	failureClass: string | null;
	createdAt: string;
	expiresAt?: string;
	/** Length of what the owner entered — a truncated paste is visible; the value never is. */
	secretLength?: number;
	hasLeadingTrailingWhitespace?: boolean;
}

export async function beginEnrollment(
	env: Env,
	input: { userId: string; instanceId: string; endpoint: string; accountId: string; label: string | null },
): Promise<{ enrollmentId: string }> {
	const label = `Bridge secret for ${input.endpoint}${input.accountId ? ` (${input.accountId})` : ""}`;
	const id = await createSecureInputRequest(env, {
		instanceId: input.instanceId,
		userId: input.userId,
		label,
		purpose: EMAIL_WORKER_ENROLL_PURPOSE,
		destinationScope: "env",
		oneShot: true,
	});
	await env.DB.prepare("INSERT INTO email_worker_enrollments (id, user_id, instance_id, endpoint, account_id, account_label) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
		.bind(id, input.userId, input.instanceId, input.endpoint, input.accountId, input.label)
		.run();
	return { enrollmentId: id };
}

async function loadEnrollment(env: Env, userId: string, instanceId: string, id: string): Promise<EnrollmentRow | null> {
	return env.DB.prepare("SELECT * FROM email_worker_enrollments WHERE id = ?1 AND user_id = ?2 AND instance_id = ?3").bind(id, userId, instanceId).first<EnrollmentRow>();
}

export async function enrollmentView(env: Env, userId: string, instanceId: string, id: string): Promise<EnrollmentView | null> {
	const row = await loadEnrollment(env, userId, instanceId, id);
	if (!row) return null;
	const si = await getSecureInputStatus(env, id, instanceId, userId);
	const base = { enrollmentId: row.id, endpoint: row.endpoint, accountId: row.account_id ?? "", label: row.account_label, failureClass: row.failure_class, createdAt: row.created_at };
	if (row.outcome === "connected") return { ...base, state: "connected" };
	let state: EnrollmentView["state"] = si?.status === "ready" ? "ready" : si?.status === "expired" ? "expired" : si?.status === "consumed" ? "consumed" : "pending";
	if (row.outcome === "probe_failed" && si?.status === "ready") state = "probe_failed";
	return { ...base, state, ...(si ? { expiresAt: si.expiresAt } : {}), ...(typeof si?.length === "number" ? { secretLength: si.length, hasLeadingTrailingWhitespace: si.hasLeadingTrailingWhitespace } : {}) };
}

export type CompleteResult =
	| { ok: true; contractVersion: string; address: string | null }
	| { ok: false; status: 404 | 409 | 422; code: "not_found" | "not_entered" | "already_connected" | "probe_failed"; message: string; failureClass?: string };

/**
 * Consume the owner's entered value, test the bridge with it, and store the connection. A probe that fails puts
 * the value BACK (the enrollment stays completable once the owner fixes the Worker), so a Worker outage never
 * costs the owner a re-entry — and never stores a connection that could not identify itself.
 */
export async function completeEnrollment(env: Env, userId: string, instanceId: string, id: string): Promise<CompleteResult> {
	const row = await loadEnrollment(env, userId, instanceId, id);
	if (!row) return { ok: false, status: 404, code: "not_found", message: "No such enrollment for this instance." };
	if (row.outcome === "connected") return { ok: false, status: 409, code: "already_connected", message: "This enrollment already created its connection." };
	const secret = await consumeSecureInput(env, id, instanceId, userId, { enrollment: true });
	if (!secret) return { ok: false, status: 409, code: "not_entered", message: "The owner has not entered the bridge secret yet (or the request expired). Hand them the console link and try again." };
	const value = secret.trim();
	const accountId = row.account_id ?? "";
	const probe = value ? await probeEmailWorkerIdentity(row.endpoint, value) : ({ ok: false, error: "The entered value was empty.", failureClass: "auth" } as const);
	if (!probe.ok) {
		await restoreConsumedSecureInput(env, id, userId, secret);
		await env.DB.prepare("UPDATE email_worker_enrollments SET outcome = 'probe_failed', failure_class = ?2 WHERE id = ?1").bind(id, probe.failureClass).run();
		// The adapter's message can echo response text; it was produced without the secret in a log-safe path (AdapterError), and is scrubbed here regardless.
		const message = probe.error.split(value).join("[redacted]");
		return { ok: false, status: 422, code: "probe_failed", message: `Could not connect: ${message}`, failureClass: probe.failureClass };
	}
	await saveEmailWorkerConnection(env, { userId, endpoint: row.endpoint, accountId, secret: value, accountLabel: row.account_label, contractVersion: probe.contractVersion });
	await recordProbeSuccess(env, userId, row.endpoint, accountId, probe.snapshot);
	await env.DB.prepare("UPDATE email_worker_enrollments SET outcome = 'connected', failure_class = NULL, completed_at = datetime('now') WHERE id = ?1").bind(id).run();
	return { ok: true, contractVersion: probe.contractVersion, address: probe.address };
}
