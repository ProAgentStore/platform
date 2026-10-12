/**
 * Browser verification settings and runtime eligibility, per instance (#1031).
 *
 * `GET/PUT /v1/instances/:id/browser-verification` — the owner's settings (`lib/browser-verification.ts`),
 * beside the agent's declared capability, the runner pin and the notification events it raises.
 * `GET /v1/instances/:id/browser-verification/runtimes` — every machine of the owner's, with
 * attachment, health, version and eligibility apart, and the one the setting would choose.
 *
 * Mounted from `registerLocalBrowserRoutes`: this is the local-browser capability's owner switch.
 */
import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { BROWSER_VERIFICATION_EVENTS, mergeBrowserVerification, readBrowserVerification, writeBrowserVerification } from "../lib/browser-verification.js";
import { browserRuntimeCandidates, selectBrowserRuntime } from "../lib/browser-verification-runtimes.js";
import { effectiveLocalBrowserPolicy } from "../lib/local-browser/policy.js";
import { localBrowserCapability } from "../lib/local-browser/start.js";
import { readLocalBrowserSettings } from "../lib/local-browser/store.js";
import { requireOwnedInstance } from "./instances-runtime.js";
import type { Env } from "../types.js";

type C = Context<{ Bindings: Env }>;

async function owned(c: C): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return { uid: session.uid, instanceId };
}

/** The declared capability, as the settings answer it — never an error: an undeclared agent reads `declared: false`. */
async function declaredCapability(c: C, instanceId: string, uid: string): Promise<{ declared: boolean; engine: string | null; detail?: string }> {
	const cap = await localBrowserCapability(c.env, instanceId, uid);
	if ("error" in cap) return { declared: false, engine: null, detail: cap.error };
	const { settings } = await readLocalBrowserSettings(c.env, instanceId, uid);
	const effective = effectiveLocalBrowserPolicy(cap.cap, settings);
	return { declared: true, engine: "error" in effective ? (cap.cap.engines[0] ?? null) : effective.engine };
}

export function registerBrowserVerificationRoutes(router: Hono<{ Bindings: Env }>): void {
	router.get("/:instanceId/browser-verification", async (c) => {
		const { uid, instanceId } = await owned(c);
		const [{ settings, runnerNode }, capability] = await Promise.all([readBrowserVerification(c.env, instanceId, uid), declaredCapability(c, instanceId, uid)]);
		return c.json({ settings, capability, runnerNode, notificationEvents: BROWSER_VERIFICATION_EVENTS });
	});

	/** Patch semantics: a field present replaces it. The runner is pinned with `PUT …/runner-node`, consent with `PUT …/local-browser/consent`. */
	router.put("/:instanceId/browser-verification", async (c) => {
		const { uid, instanceId } = await owned(c);
		const patch = (await c.req.json().catch(() => null)) as unknown;
		if (patch && typeof patch === "object" && ("runnerNode" in patch || "consent" in patch)) {
			throw new HttpError(400, "The runner is pinned with PUT /v1/instances/:id/runner-node and site consent is given with PUT /v1/instances/:id/local-browser/consent; neither is a browser verification setting.");
		}
		const [{ settings: stored, runnerNode }, capability] = await Promise.all([readBrowserVerification(c.env, instanceId, uid), declaredCapability(c, instanceId, uid)]);
		const merged = mergeBrowserVerification(stored, patch, capability.declared);
		if ("error" in merged) throw new HttpError(400, merged.error);
		await writeBrowserVerification(c.env, instanceId, uid, merged.settings);
		return c.json({ settings: merged.settings, capability, runnerNode, notificationEvents: BROWSER_VERIFICATION_EVENTS });
	});

	router.get("/:instanceId/browser-verification/runtimes", async (c) => {
		const { uid, instanceId } = await owned(c);
		const [{ settings, runnerNode }, capability] = await Promise.all([readBrowserVerification(c.env, instanceId, uid), declaredCapability(c, instanceId, uid)]);
		if (!capability.declared) return c.json({ capability, runtime: settings.runtime, runnerNode, machines: [], selected: null });
		const machines = await browserRuntimeCandidates(c.env, instanceId, uid, { engine: capability.engine ?? "claude", pinnedNode: runnerNode });
		const selected = selectBrowserRuntime(machines, settings.runtime);
		return c.json({
			capability,
			runtime: settings.runtime,
			runnerNode,
			machines,
			selected: selected?.node ?? null,
			...(selected ? {} : { fallback: settings.fallback, detail: settings.runtime === "pinned" && !runnerNode ? "runtime is \"pinned\" but this agent is not pinned to a machine. Pin it, or choose any_eligible." : `No eligible machine now; the fallback (${settings.fallback}) applies.` }),
		});
	});
}
