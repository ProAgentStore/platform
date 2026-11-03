import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RunnerInputError } from "../errors.js";

export const APPLY_START_UNCERTAIN = "application_start_uncertain";

function uncertain(): RunnerInputError {
	return new RunnerInputError("A previous start of this application has no available execution receipt. It may have acted on the employer site. PAGS will not start it again; reconcile the previous run before retrying.", 409, APPLY_START_UNCERTAIN);
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const runClaim = (root: string, runDir: string) => join(root, `run-${hash(resolve(runDir))}.json`);
type StartIdentity = { instanceId: string; runId: string; requestId: string };
const requestClaim = (root: string, identity: StartIdentity) => join(root, `request-${hash(JSON.stringify([identity.instanceId, identity.requestId]))}.json`);

/** Exclusive and durable before any browser/CLI starts. An incomplete claim also refuses replay. */
function writeClaim(path: string, value: object, existingIsOk = false): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	let fd: number;
	try { fd = openSync(path, "wx", 0o600); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			if (existingIsOk) return;
			throw uncertain();
		}
		throw error;
	}
	try {
		writeFileSync(fd, JSON.stringify(value));
		fsyncSync(fd);
	} finally { closeSync(fd); }
	// Windows cannot open a directory for fsync. Process-crash refusal still follows from wx.
	if (process.platform !== "win32") {
		const directory = openSync(dirname(path), "r");
		try { fsyncSync(directory); } finally { closeSync(directory); }
	}
}

/** Keep only an id-derived tombstone when retention removes an old run's scratch directory. */
export function rememberApplyStart(root: string, runDir: string, identity?: StartIdentity): void {
	writeClaim(runClaim(root, runDir), { version: 1 }, true);
	if (identity) writeClaim(requestClaim(root, identity), { version: 1, runId: identity.runId }, true);
}

/** Never reuse an interrupted run directory or request, including after runner restart/retention. */
export function claimApplyStart(root: string, runDir: string, identity: StartIdentity): void {
	const existingRun = existsSync(runDir);
	writeClaim(requestClaim(root, identity), { version: 1, runId: identity.runId });
	writeClaim(runClaim(root, runDir), { version: 1 });
	if (existingRun) throw uncertain();
}
