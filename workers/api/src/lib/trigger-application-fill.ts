/** The application-fill trigger adapter owns its review-only transfer flag and response shape. */
import type { Env } from "../types.js";

/**
 * #1010's receipt-backed manual delivery persists `reviewOnly` on its outbox row. Ordinary
 * connections stay policy-driven; this flag can only narrow a fill to review, never auto-submit.
 */
export async function startApplicationFillForTrigger(env: Env, instanceId: string, userId: string, payload: unknown, config: unknown): Promise<Record<string, unknown>> {
	const review = Boolean(config && typeof config === "object" && !Array.isArray(config) && (config as Record<string, unknown>).reviewOnly === true);
	// Deferred like the Tailor: apply's dependency graph reaches the connection pump, which calls
	// this trigger executor. Loading it only for the selected action keeps that graph acyclic.
	const { startApplicationFill } = await import("./local-apply/apply.js");
	const out = await startApplicationFill(env, instanceId, userId, payload, "connection", { review });
	return { applicationId: out.application.id, status: out.application.status, runId: out.run?.id ?? null, outcome: out.kind, mode: out.run?.policy.mode ?? null };
}
