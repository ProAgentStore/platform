/**
 * The runner CLI's half of post-run cleanup (#1265).
 *
 * The platform owns the per-machine mode and its switches; the local runner (packages/browser-runner)
 * obeys them. This module is the courier between the two, riding the heartbeat that already exists:
 *
 *   before each beat  `collect`  feeds the machine's reading to the local runner (load, session CPU, disk —
 *                     so it can warn about load nothing explains and prune a nearly full disk) and returns
 *                     its status — the active mode, the leftovers it found, its last pass — for the beat.
 *   after each beat   `accept`   applies the policy the platform answered with, and starts a cleanup pass
 *                     when the owner asked for one ("clean now").
 *
 * Two rules keep it from hurting the thing it rides on. A pass can take minutes (a cache prune), so it runs
 * in the BACKGROUND — an awaited pass would stall the 30s heartbeat and the machine would read as offline.
 * And nothing here ever throws into the heartbeat: a runner that is slow or old costs this beat its cleanup
 * numbers, not its presence.
 */
import type { ResourceSample } from "./resources.js";

export interface CleanupStatusWire {
	mode: "gentle" | "harsh";
	behaviours: Record<string, boolean>;
	orphanedProcesses: number;
	orphans: Array<{ pid: number; reason: string; sessionId?: string; command: string }>;
	loadMismatch: boolean;
	unexplainedLoad: number;
	diskUsedPct: number | null;
	warnings: string[];
	lastPass: Record<string, unknown> | null;
}

export interface CleanupBeat {
	/** The runner's status, or null when it could not be read this beat (an older runner, a slow one). */
	status: CleanupStatusWire | null;
	/** The `requestedAt` of the newest "clean now" pass this machine has FINISHED — the platform stops asking once it sees it. */
	doneAt?: number;
}

export interface CleanupSync {
	collect(resources: ResourceSample): Promise<CleanupBeat>;
	accept(response: unknown): Promise<void>;
}

export function createCleanupSync(localUrl: string, token: string, fetchImpl: typeof fetch = fetch, log: (line: string) => void = () => undefined): CleanupSync {
	let appliedPolicy = "";
	let handledNowAt = 0;
	let doneNowAt = 0;
	const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
	const post = async (path: string, body: unknown, timeoutMs: number): Promise<unknown | null> => {
		try {
			const res = await fetchImpl(`${localUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
			return res.ok ? await res.json() : null;
		} catch {
			return null; // an old runner (404), a busy one (timeout): this beat goes without
		}
	};

	return {
		async collect(resources) {
			const sessionsCpu = resources.sessions ? resources.sessions.reduce((n, s) => n + s.cpuPct, 0) : null;
			const body = await post("/coding/cleanup/observe", { load1: resources.loadAvg ? resources.loadAvg[0] : null, cpus: resources.cpus, sessionsCpuPct: sessionsCpu, diskPath: resources.disk?.path ?? "" }, 15_000);
			const status = body && typeof body === "object" && "mode" in body ? (body as CleanupStatusWire) : null;
			return { status, ...(doneNowAt ? { doneAt: doneNowAt } : {}) };
		},

		async accept(response) {
			if (!response || typeof response !== "object") return;
			const r = response as { cleanupPolicy?: unknown; cleanupNow?: { requestedAt?: unknown } | null };
			if (r.cleanupPolicy && typeof r.cleanupPolicy === "object") {
				const serialized = JSON.stringify(r.cleanupPolicy);
				if (serialized !== appliedPolicy) {
					const ok = await post("/coding/cleanup/policy", { policy: r.cleanupPolicy }, 5000);
					if (ok) appliedPolicy = serialized; // not remembered when it failed: the next beat tries again
				}
			}
			const requestedAt = typeof r.cleanupNow?.requestedAt === "number" ? r.cleanupNow.requestedAt : 0;
			if (requestedAt > handledNowAt) {
				handledNowAt = requestedAt;
				log(`[runner] cleanup pass requested from the console — running it now`);
				// Background, on purpose: see the header. Done is recorded only when the runner says it finished.
				void post("/coding/cleanup/run", { reason: "requested from the console" }, 15 * 60_000).then((report) => {
					if (report) doneNowAt = requestedAt;
					else handledNowAt = 0; // it did not run: ask again on the next beat
				});
			}
		},
	};
}
