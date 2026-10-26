/** Per-machine native-control opt-in routes (#1057), mounted beside the terminals machine routes. */
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { logEvent } from "../lib/events.js";
import { getNativeHalt, haltNative, resumeNative } from "../lib/native/halt.js";
import { getNativeOptIn, nativeOptInWire, NATIVE_RISK_DISCLOSURE_V1, setNativeOptIn } from "../lib/native/policy.js";
import { machineDetail } from "./terminals.js";
import type { Env } from "../types.js";

export const terminalNativeRoutes = new Hono<{ Bindings: Env }>();

/**
 * Native desktop / Maestro control opt-in for one machine (#1057). Owner-only and per machine, OFF
 * by default; enabling requires the current account-risk disclosure version (lib/native/policy.ts).
 * GET returns the switches and the disclosure text to show; POST sets them. Works while offline.
 */
terminalNativeRoutes.get("/machines/:machineId/native-optin", async (c) => {
	const session = await requireUser(c);
	const machine = await machineDetail(c.env, session.uid, c.req.param("machineId"));
	if (!machine?.machineId) return c.json({ error: "No identified machine is registered under this account." }, 404);
	return c.json({ optIn: nativeOptInWire((await getNativeOptIn(c.env, session.uid, machine.machineId))!) });
});
terminalNativeRoutes.post("/machines/:machineId/native-optin", async (c) => {
	const session = await requireUser(c);
	const machine = await machineDetail(c.env, session.uid, c.req.param("machineId"));
	if (!machine?.machineId) return c.json({ error: "No identified machine is registered under this account." }, 404);
	const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
	const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
	const ack = body.acknowledged_disclosure_version ?? body.acknowledgedDisclosureVersion;
	const out = await setNativeOptIn(c.env, session.uid, machine.machineId, {
		desktop: flag(body.desktop),
		maestro: flag(body.maestro),
		acknowledgedDisclosureVersion: typeof ack === "string" ? ack : null,
	});
	if (!out.ok) return c.json({ code: out.code, error: out.error, current_disclosure: NATIVE_RISK_DISCLOSURE_V1 }, out.status);
	await logEvent(c.env, { source: "tool", event: "native.optin_changed", message: `native control on ${machine.node}: desktop=${out.optIn.desktop} maestro=${out.optIn.maestro}`, userId: session.uid, level: "info", context: { machineId: machine.machineId, desktop: out.optIn.desktop, maestro: out.optIn.maestro, disclosureVersion: out.optIn.disclosureVersion } }).catch(() => undefined);
	return c.json({ optIn: nativeOptInWire(out.optIn) });
});

/**
 * The HALT on a machine's native control (#1057, slice 3), owner side. The agent can stop itself (`native_halt`); only the owner
 * clears it. Halt works whether or not the machine is opted in or the runner is reachable: the cloud refuses every native act
 * while the row exists, and the runner is told when it can be.
 */
terminalNativeRoutes.get("/machines/:machineId/native-halt", async (c) => {
	const session = await requireUser(c);
	const machine = await machineDetail(c.env, session.uid, c.req.param("machineId"));
	if (!machine?.machineId) return c.json({ error: "No identified machine is registered under this account." }, 404);
	const halt = await getNativeHalt(c.env, session.uid, machine.machineId);
	return c.json({ halted: !!halt, ...(halt ? { by: halt.by, reason: halt.reason, at: halt.at } : {}) });
});
terminalNativeRoutes.post("/machines/:machineId/native-halt", async (c) => {
	const session = await requireUser(c);
	const machine = await machineDetail(c.env, session.uid, c.req.param("machineId"));
	if (!machine?.machineId) return c.json({ error: "No identified machine is registered under this account." }, 404);
	const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
	const out = await haltNative(c.env, session.uid, machine.machineId, "owner", typeof body.reason === "string" ? body.reason : undefined);
	return c.json(out);
});
terminalNativeRoutes.post("/machines/:machineId/native-resume", async (c) => {
	const session = await requireUser(c);
	const machine = await machineDetail(c.env, session.uid, c.req.param("machineId"));
	if (!machine?.machineId) return c.json({ error: "No identified machine is registered under this account." }, 404);
	return c.json(await resumeNative(c.env, session.uid, machine.machineId));
});
