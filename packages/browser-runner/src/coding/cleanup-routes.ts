/**
 * The runner's local cleanup endpoints (#1265), token-gated like the rest of `server.ts`.
 *
 *   POST /coding/cleanup/policy   the platform's resolved per-machine policy, relayed by the CLI on the heartbeat
 *   POST /coding/cleanup/observe  the machine's reading (load, session CPU, disk) → the runner's status
 *   GET  /coding/cleanup/status   the status alone
 *   POST /coding/cleanup/run      a cleanup pass now (the platform's "clean now")
 *
 * Kept out of server.ts, which is already over its size pin, and as a function of (method, path, runtime) so it
 * is testable without a socket. Returns null for a path that is not one of these.
 */
import { parseCleanupPolicy } from "./cleanup.js";
import type { CodingRuntime } from "./runtime.js";

export async function handleCleanupRoute(
	method: string,
	path: string,
	coding: Pick<CodingRuntime, "cleanup" | "enginePids" | "cleanupNow">,
	readBody: () => Promise<Record<string, unknown>>,
): Promise<{ body: unknown } | null> {
	if (method === "GET" && path === "/coding/cleanup/status") return { body: coding.cleanup.status() };
	if (method !== "POST") return null;
	if (path === "/coding/cleanup/policy") {
		coding.cleanup.setPolicy(parseCleanupPolicy((await readBody()).policy));
		return { body: { ok: true, mode: coding.cleanup.policy.mode } };
	}
	if (path === "/coding/cleanup/observe") {
		const b = await readBody();
		const live = coding.enginePids();
		const diskPath = typeof b.diskPath === "string" ? b.diskPath : "";
		await coding.cleanup.observe(
			{ load1: Number(b.load1) || 0, cpus: Number(b.cpus) || 1, sessionsCpuPct: typeof b.sessionsCpuPct === "number" ? b.sessionsCpuPct : null, diskPath },
			new Set(live.map((l) => l.sessionId)),
			live.map((l) => l.pid),
		);
		return { body: coding.cleanup.status(diskPath || undefined) };
	}
	if (path === "/coding/cleanup/run") {
		const b = await readBody().catch((): Record<string, unknown> => ({}));
		return { body: await coding.cleanupNow(typeof b.reason === "string" && b.reason ? clip(b.reason) : "requested") };
	}
	return null;
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s);
