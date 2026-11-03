/**
 * The tiny, best-effort durable record of a background clone (#1459) — same idiom as
 * `headless-state.ts`'s resume-id store: a plain JSON file under the repos base dir, read and
 * written defensively, never load-bearing for correctness within a single runner process (the
 * in-memory `CloneJobs` map is authoritative there). Its only job is to survive what the in-memory
 * map cannot: a crash or a forced restart of the runner process itself.
 *
 * Binds a receipt to the requested repo, its canonical destination, a job id, and the OWNING
 * runner process's identity and git child pid — never a credential. `cloneUrlFor` never embeds
 * one (the machine's own credential helper or SSH key decides transport), so there is nothing
 * secret to keep out in the first place; the schema is kept this narrow on purpose so that stays
 * true by construction, not by review.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloneProtocol } from "./repo-clone-job.js";

export interface CloneReceipt {
	path: string;
	slug: string;
	protocol: CloneProtocol;
	jobId: string;
	/** Identifies the runner PROCESS that owns this job — fresh every boot. A receipt whose id
	 *  does not match the CURRENT runner's is from a process that no longer exists, by definition:
	 *  this process just booted, so if it already held that id it would remember the job in
	 *  memory and never need to consult the receipt at all. */
	runnerInstanceId: string;
	/** The git child's OS pid, when one was captured. Liveness is checked, never assumed, and
	 *  never resolved as evidence of OUTCOME by itself — only of whether the attempt is still
	 *  physically running (#1459: a reused pid is rare, but a dead one is never read as "done"). */
	pid: number | null;
	startedAt: number;
}

interface ReceiptFile {
	[path: string]: CloneReceipt;
}

function loadFile(path: string): ReceiptFile {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as ReceiptFile;
	} catch {
		return {};
	}
}

export function readReceipt(storePath: string, cloneDir: string): CloneReceipt | null {
	const file = loadFile(storePath);
	const receipt = file[cloneDir];
	return receipt && typeof receipt === "object" ? receipt : null;
}

export function writeReceipt(storePath: string, receipt: CloneReceipt): void {
	try {
		const file = loadFile(storePath);
		file[receipt.path] = receipt;
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(storePath, JSON.stringify(file));
	} catch {
		/* best-effort persistence — the in-memory job is still correct for THIS process */
	}
}

export function clearReceipt(storePath: string, cloneDir: string): void {
	try {
		const file = loadFile(storePath);
		if (!(cloneDir in file)) return;
		delete file[cloneDir];
		writeFileSync(storePath, JSON.stringify(file));
	} catch {
		/* best-effort */
	}
}

/** Default location for the clone-receipt store, under the repos base dir. */
export function defaultReceiptStorePath(reposBaseDir: string): string {
	return join(reposBaseDir, "clone-receipts.json");
}
