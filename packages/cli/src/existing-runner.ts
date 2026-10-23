/**
 * Is the thing already on this runner's port a healthy runner of ours? (#1295)
 *
 * `pags up` beside a healthy background service used to print EADDRINUSE, report crashes and start again every few
 * seconds, so a working machine read as a failing one. A port that is taken is one of two different facts, and the
 * product has to say which:
 *
 *   - `pags-runner`: a ProAgentStore runtime is serving it — this machine is already connected and nothing needs
 *     starting. Said once, exit {@link RUNNER_ALREADY_RUNNING_EXIT_CODE}, no crash report, no retry.
 *   - `other`: something else is bound there (or something that will not say who it is). That IS a failed start, and
 *     the diagnosis names the port and what answered so the person can act — without claiming the service is offline.
 *
 * Nothing here stops, replaces or signals anything. The only takeover is the explicit `pags up --replace`.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { inspectHolder, lockDir, readLock } from "./runner-lock.js";

/** `runner connect` / `pags up` found a healthy runner already serving this account here: not a crash, not retried. */
export const RUNNER_ALREADY_RUNNING_EXIT_CODE = 78;

export type PortOccupant = { kind: "pags-runner" } | { kind: "other"; detail: string };

/** The runtime's own `/health` service name (browser-runner `server.ts`). */
const RUNTIME_SERVICE = "proagentstore-browser-runtime";

export interface IdentifyDeps {
	fetchImpl?: typeof fetch;
	/** Lock files to consult; defaults to every `up-*.lock` in the machine's config directory. */
	lockFiles?: () => string[];
	timeoutMs?: number;
}

function defaultLockFiles(): string[] {
	try {
		const dir = lockDir();
		return readdirSync(dir).filter((f) => /^up-[0-9a-f]+\.lock$/.test(f)).map((f) => join(dir, f));
	} catch {
		return [];
	}
}

/**
 * Who answers on `127.0.0.1:port`. Two proofs of "ours": the runtime's unauthenticated identity, or a lock file whose
 * holder is live on that port (its `/health` quoting the lock's rsid) — the second is what covers a runtime that
 * insists on its bearer token. A listener that proves neither is `other`, never assumed to be ours.
 */
export async function identifyPortOccupant(port: number, deps: IdentifyDeps = {}): Promise<PortOccupant> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	let detail = "it did not answer HTTP";
	try {
		const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(deps.timeoutMs ?? 3000) });
		detail = `it answered HTTP ${res.status}`;
		if (res.ok) {
			const body = (await res.json().catch(() => null)) as { service?: unknown } | null;
			if (body?.service === RUNTIME_SERVICE) return { kind: "pags-runner" };
			detail = "it answered HTTP 200 but is not a ProAgentStore runtime";
		}
	} catch {
		/* no HTTP answer: fall through to the lock files */
	}
	for (const file of (deps.lockFiles ?? defaultLockFiles)()) {
		const lock = readLock(file);
		if (!lock || lock.port !== port) continue;
		const { verdict } = await inspectHolder(file, { fetchImpl, healthTimeoutMs: deps.timeoutMs ?? 3000 });
		if (verdict === "live") return { kind: "pags-runner" };
	}
	return { kind: "other", detail };
}

/** What a second `pags up` says instead of an error: connected already, how to look, and the explicit takeover. */
export function alreadyRunningLines(port?: number): string[] {
	return [
		`This machine is already connected — a ProAgentStore runner is running here${port ? ` (127.0.0.1:${port})` : ""}. No manual start is needed.`,
		"",
		"  pags status            — what it is doing",
		"  pags up --replace      — stop it gracefully and take over (never done implicitly)",
		"  pags down              — stop it",
	];
}

/** A genuine port collision: complete, and honest that the existing service (if any) is not what failed. */
export function portCollisionLines(port: number, detail: string): string[] {
	return [
		`Port ${port} on 127.0.0.1 is already in use, and the program using it is not a ProAgentStore runner this CLI can identify (${detail}).`,
		"  This is a port collision, not an offline runner — a runner that is already connected is unaffected.",
		`  Find what holds it:   lsof -nP -iTCP:${port} -sTCP:LISTEN   (Windows: netstat -ano | findstr :${port})`,
		"  Then stop that program, or run `pags status` to see whether a runner of yours is already up here.",
	];
}
