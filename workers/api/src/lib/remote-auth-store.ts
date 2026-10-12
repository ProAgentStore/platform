/**
 * PAS remote sign-in requests, stored (#1005). Owner-scoped rows of what the owner's own machine relayed;
 * the rules are `remote-auth.ts`. The first relay of a PAS request pushes the owner a same-origin link to
 * it — a repeat relay is the same request (no second push), and a relay of the same PAS id with different
 * details is refused rather than merged.
 */
import type { Env } from "../types.js";
import { deepLinkFor } from "./console-links.js";
import { type RemoteAuthRelay, type RemoteAuthRequestView, type RemoteAuthState, effectiveState, isTerminal, transitionAllowed } from "./remote-auth.js";
import { notifyUser } from "../routes/push.js";

type Row = Record<string, unknown>;
const iso = (ms: unknown) => new Date(Number(ms)).toISOString();

function view(r: Row, now = Date.now()): RemoteAuthRequestView {
	const state = r.state as RemoteAuthState;
	return {
		id: String(r.id),
		pasRequestId: String(r.pas_request_id),
		agent: { id: String(r.agent_id), label: String(r.agent_label) },
		machine: { id: String(r.machine_id), label: String(r.machine_label) },
		relayedBy: { node: (r.runner_node as string | null) ?? null, machineId: (r.runner_machine_id as string | null) ?? null },
		service: "ProAppStore MCP",
		resource: String(r.resource),
		scopes: JSON.parse(String(r.scopes ?? "[]")) as string[],
		approvalUrl: String(r.approval_url),
		state,
		effectiveState: effectiveState(state, Number(r.expires_at), now),
		expiresAt: iso(r.expires_at),
		lastReportedAt: iso(r.last_reported_at),
		createdAt: iso(r.created_at),
		history: JSON.parse(String(r.history ?? "[]")),
	};
}

export async function getRemoteAuthRequest(env: Pick<Env, "DB">, userId: string, id: string, now = Date.now()): Promise<RemoteAuthRequestView | null> {
	const r = await env.DB.prepare("SELECT * FROM remote_auth_requests WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<Row>();
	return r ? view(r, now) : null;
}

const sameRelay = (r: Row, x: RemoteAuthRelay) =>
	r.agent_id === x.agent.id && r.agent_label === x.agent.label && r.machine_id === x.machine.id && r.machine_label === x.machine.label && r.resource === x.resource && r.approval_url === x.approvalUrl && Number(r.expires_at) === x.expiresAt && String(r.scopes) === JSON.stringify(x.scopes);

export async function relayRemoteAuthRequest(
	env: Env,
	userId: string,
	relay: RemoteAuthRelay,
	by: { node: string | null; machineId: string | null },
	now = Date.now(),
): Promise<{ ok: true; request: RemoteAuthRequestView; duplicate: boolean } | { ok: false; status: 409; error: string }> {
	const id = `rar_${crypto.randomUUID()}`;
	const inserted = (
		await env.DB.prepare(
			`INSERT INTO remote_auth_requests (id, user_id, pas_request_id, agent_id, agent_label, machine_id, machine_label, runner_node, runner_machine_id, resource, scopes, approval_url, state, expires_at, last_reported_at, history, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'pending', ?13, ?14, ?15, ?14, ?14)
			 ON CONFLICT(user_id, pas_request_id) DO NOTHING`,
		)
			.bind(id, userId, relay.pasRequestId, relay.agent.id, relay.agent.label, relay.machine.id, relay.machine.label, by.node, by.machineId, relay.resource, JSON.stringify(relay.scopes), relay.approvalUrl, relay.expiresAt, now, JSON.stringify([{ at: now, state: "pending" }]))
			.run()
	).meta?.changes;
	const row = (await env.DB.prepare("SELECT * FROM remote_auth_requests WHERE user_id = ?1 AND pas_request_id = ?2").bind(userId, relay.pasRequestId).first<Row>()) as Row;
	if (!inserted) {
		// A repeat relay (a retried CLI call, a duplicate start) is the same request. Anything different under
		// the same PAS id is not — refused, so a relay can never retarget a request the owner was shown.
		if (!sameRelay(row, relay) || (row.runner_machine_id && by.machineId && row.runner_machine_id !== by.machineId)) {
			return { ok: false, status: 409, error: "A request with this PAS id was already relayed with different details." };
		}
		return { ok: true, request: view(row, now), duplicate: true };
	}
	const resourceTail = relay.resource.replace(/^https?:\/\/[^/]+/, "");
	await notifyUser(
		env,
		userId,
		"remote-auth",
		"🔐 Approve a ProAppStore sign-in",
		`${relay.agent.label} on ${relay.machine.label} asks to connect to ProAppStore MCP (${resourceTail}). Review it, then sign in at ProAppStore.`,
		deepLinkFor({ kind: "remote-auth-request", requestId: String(row.id) }),
		{ kind: "alert", key: `remote-auth:${row.id}` },
	).catch(() => undefined);
	return { ok: true, request: view(row, now), duplicate: false };
}

/** The machine reports the broker state it observed. Forward-only; only the machine that relayed it may report. */
export async function reportRemoteAuthState(
	env: Pick<Env, "DB">,
	userId: string,
	id: string,
	next: RemoteAuthState,
	by: { machineId: string | null },
	now = Date.now(),
): Promise<{ ok: true; request: RemoteAuthRequestView; changed: boolean } | { ok: false; status: 404 | 409; error: string }> {
	const row = await env.DB.prepare("SELECT * FROM remote_auth_requests WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<Row>();
	if (!row) return { ok: false, status: 404, error: "No such request." };
	if (row.runner_machine_id && row.runner_machine_id !== by.machineId) return { ok: false, status: 409, error: "Only the machine that relayed this request may report its state." };
	const from = row.state as RemoteAuthState;
	const move = transitionAllowed(from, next);
	if (move === "refused") return { ok: false, status: 409, error: `A ${from} request cannot become ${next}.` };
	if (move === "same") {
		await env.DB.prepare("UPDATE remote_auth_requests SET last_reported_at = ?2 WHERE id = ?1").bind(id, now).run();
		return { ok: true, request: view({ ...row, last_reported_at: now }, now), changed: false };
	}
	// Conditional on the state read, so two racing reports cannot both move it.
	const moved = (
		await env.DB.prepare(
			"UPDATE remote_auth_requests SET state = ?3, last_reported_at = ?4, updated_at = ?4, history = json_insert(history, '$[#]', json(?5)) WHERE id = ?1 AND user_id = ?2 AND state = ?6",
		)
			.bind(id, userId, next, now, JSON.stringify({ at: now, state: next }), from)
			.run()
	).meta?.changes;
	if (!moved) return { ok: false, status: 409, error: "The request changed meanwhile; read it again." };
	const fresh = (await env.DB.prepare("SELECT * FROM remote_auth_requests WHERE id = ?1").bind(id).first<Row>()) as Row;
	return { ok: true, request: view(fresh, now), changed: true };
}

export { isTerminal };
