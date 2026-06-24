import { Hono, type Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { createCredential, deleteCredential, listCredentials, revealCredential, updateCredential, type CredentialInput } from "../lib/credentials.js";
import type { Env } from "../types.js";

export const credentialRoutes = new Hono<{ Bindings: Env }>();

/** Confirm the caller owns the instance (credentials are per-instance, owner-only). */
async function requireOwned(c: Context<{ Bindings: Env }>): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	const owned = await c.env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2").bind(instanceId, session.uid).first();
	if (!owned) throw new HttpError(404, "Instance not found");
	return { uid: session.uid, instanceId };
}

function readInput(body: Record<string, unknown>): CredentialInput {
	const s = (v: unknown) => (typeof v === "string" ? v : undefined);
	return {
		domain: String(body.domain ?? "").trim(),
		loginUrl: s(body.loginUrl ?? body.login_url),
		username: s(body.username),
		password: s(body.password),
		pin: s(body.pin),
		recoveryCodes: s(body.recoveryCodes ?? body.recovery_codes),
		comments: s(body.comments),
		recoveryHistory: s(body.recoveryHistory ?? body.recovery_history),
	};
}

/** List credentials (summaries only — never the secret values). */
credentialRoutes.get("/:instanceId/credentials", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	return c.json({ credentials: await listCredentials(c.env, instanceId, uid) });
});

/** Reveal one credential's secrets (owner-only, explicit). */
credentialRoutes.get("/:instanceId/credentials/:id/reveal", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const cred = await revealCredential(c.env, instanceId, uid, c.req.param("id"));
	if (!cred) throw new HttpError(404, "Credential not found");
	return c.json(cred);
});

/** Create a credential. */
credentialRoutes.post("/:instanceId/credentials", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const input = readInput((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
	if (!input.domain) return c.json({ error: "domain (or a login URL) is required" }, 400);
	const id = await createCredential(c.env, instanceId, uid, input);
	return c.json({ id, ok: true }, 201);
});

/** Update a credential (secrets left unchanged unless supplied). */
credentialRoutes.put("/:instanceId/credentials/:id", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const input = readInput((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
	const ok = await updateCredential(c.env, instanceId, uid, c.req.param("id"), input);
	if (!ok) throw new HttpError(404, "Credential not found");
	return c.json({ ok: true });
});

/** Delete a credential. */
credentialRoutes.delete("/:instanceId/credentials/:id", async (c) => {
	const { uid, instanceId } = await requireOwned(c);
	const ok = await deleteCredential(c.env, instanceId, uid, c.req.param("id"));
	if (!ok) throw new HttpError(404, "Credential not found");
	return c.json({ ok: true });
});
