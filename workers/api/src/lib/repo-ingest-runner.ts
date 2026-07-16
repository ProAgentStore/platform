/**
 * Repo-ingestion runner — the multi-repo state machine, extracted from AgentDO so
 * it can be unit-tested against an in-memory store. It owns NO Cloudflare types:
 * the DO injects a thin storage interface, the storage engine, the GitHub fetchers,
 * and a clock. Storage layout (per instance DO):
 *   repoMember:{owner/repo}   marker that a repo is tracked (membership, not an array)
 *   repoJob:{owner/repo}      the RepoIngestJob
 *   rifile:{owner/repo}:{i}   a staged file awaiting embedding
 * Repo vectors live in the engine as sourceType "repo", sourceId `${key}::${path}`
 * (incl. the overview at `${key}::OVERVIEW`).
 */
import type { ExtractedFile, RepoMeta, RepoRef } from "./repo-ingest.js";

export const REPO_MAX_FILES = 300;
export const REPO_MAX_FILE_BYTES = 32_000;
export const REPO_MAX_TOTAL_BYTES = 4_000_000;
export const REPO_CHUNK_BUDGET = 60; // ~embed calls per alarm tick
export const REPO_FILE_MAX_RETRY = 1; // retry a whole-file embed failure once (later tick) before dropping
export const REPO_MAX_REPOS = 20; // indexed repos per instance

export interface RepoIngestJob {
	key: string;
	repoUrl: string;
	owner: string;
	repo: string;
	branch?: string;
	token?: string;
	status: "fetching" | "indexing" | "summarizing" | "done" | "error";
	total: number;
	done: number;
	failed: number;
	skipped: number;
	queue: number[];
	paths: string[];
	description?: string | null;
	language?: string | null;
	readme?: string | null;
	error?: string;
	startedAt: string;
	finishedAt?: string;
}

/** Minimal DO-storage surface the runner needs (satisfied by DurableObjectStorage). */
export interface RepoStore {
	get<T = unknown>(key: string): Promise<T | null | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(keyOrKeys: string | string[]): Promise<unknown>;
	list<T = unknown>(opts?: { prefix?: string }): Promise<Map<string, T>>;
}

/** Minimal storage-engine surface the runner needs. */
export interface RepoEngine {
	vectorizeRepoFile(key: string, path: string, content: string): Promise<number>;
	clearRepoVectors(key?: string): Promise<void>;
	logEvent(type: string, userId: string | undefined, data: Record<string, unknown>): Promise<unknown>;
}

/** GitHub + parsing dependencies (injected so tests can supply fakes). */
export interface RepoFetchers {
	fetchRepoMeta(ref: RepoRef, token?: string): Promise<RepoMeta | null>;
	fetchRepoTarball(ref: RepoRef, branch?: string, token?: string): Promise<Uint8Array>;
	extractTextFiles(tar: Uint8Array, opts: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number }): { files: ExtractedFile[]; skipped: number };
	buildRepoOverview(ref: RepoRef, input: { description?: string | null; language?: string | null; paths: string[]; readme?: string | null }): string;
	findReadme(files: ExtractedFile[]): string | null;
	now(): string;
}

async function deleteAll(store: RepoStore, prefix: string): Promise<void> {
	const got = await store.list({ prefix });
	const keys = [...got.keys()];
	for (let i = 0; i < keys.length; i += 128) await store.delete(keys.slice(i, i + 128));
}

export async function getRepoIndex(store: RepoStore): Promise<string[]> {
	const members = await store.list({ prefix: "repoMember:" });
	return [...members.keys()].map((k) => k.slice("repoMember:".length));
}

export async function getRepoJob(store: RepoStore, key: string): Promise<RepoIngestJob | null> {
	return (await store.get<RepoIngestJob>(`repoJob:${key}`)) ?? null;
}

/** Persist a job only if it's still current (present, same startedAt). */
export async function saveJob(store: RepoStore, prev: RepoIngestJob, patch: Partial<RepoIngestJob>): Promise<boolean> {
	const current = await getRepoJob(store, prev.key);
	if (!current || current.startedAt !== prev.startedAt) return false;
	await store.put(`repoJob:${prev.key}`, { ...prev, ...patch });
	return true;
}

/** Remove one repo's data (vectors incl. overview, staged files, job, membership). */
export async function clearRepo(store: RepoStore, engine: RepoEngine | null, key: string): Promise<void> {
	if (engine) await engine.clearRepoVectors(key).catch(() => undefined);
	await deleteAll(store, `rifile:${key}:`);
	// Drop membership first so a mid-flight tick's saveJob() guard bails before it
	// can resurrect this repo, then delete the job itself.
	await store.delete(`repoMember:${key}`);
	await store.delete(`repoJob:${key}`);
}

/** Add (or re-index) a repo. Returns the new job, or an error string. */
export async function addRepo(
	store: RepoStore,
	engine: RepoEngine | null,
	input: { ref: RepoRef; repoUrl: string; branch?: string; token?: string; now: string },
): Promise<{ job?: RepoIngestJob; error?: string }> {
	const key = `${input.ref.owner}/${input.ref.repo}`;
	const existing = await getRepoIndex(store);
	if (!existing.includes(key) && existing.length >= REPO_MAX_REPOS) {
		return { error: `Repo limit reached (max ${REPO_MAX_REPOS}). Remove one before adding another.` };
	}
	await clearRepo(store, engine, key); // re-index clears just this repo
	const job: RepoIngestJob = {
		key,
		repoUrl: input.repoUrl,
		owner: input.ref.owner,
		repo: input.ref.repo,
		branch: input.branch || undefined,
		token: input.token || undefined,
		status: "fetching",
		total: 0,
		done: 0,
		failed: 0,
		skipped: 0,
		queue: [],
		paths: [],
		startedAt: input.now,
	};
	await store.put(`repoJob:${key}`, job);
	await store.put(`repoMember:${key}`, 1);
	return { job };
}

/** Remove one repo (by key), or all when key is undefined. */
export async function removeRepo(store: RepoStore, engine: RepoEngine | null, key?: string): Promise<void> {
	if (key) await clearRepo(store, engine, key);
	else for (const k of await getRepoIndex(store)) await clearRepo(store, engine, k);
	await store.delete("mem:repository"); // retire any legacy memory entry
}

/** Client-safe per-repo status objects (token/queue/readme stripped). */
export async function statusList(store: RepoStore): Promise<Array<Partial<RepoIngestJob>>> {
	const repos: Array<Partial<RepoIngestJob>> = [];
	for (const key of await getRepoIndex(store)) {
		const job = await getRepoJob(store, key);
		if (!job) continue;
		const { token: _t, queue: _q, readme: _r, ...pub } = job;
		repos.push(pub);
	}
	// Self-heal: with no repos, drop stale legacy memory / single-repo job key.
	if (repos.length === 0) {
		await store.delete("mem:repository");
		await store.delete("repoIngest");
	}
	return repos;
}

/**
 * Advance ONE active repo by one tick. Returns true if it did work (caller should
 * reschedule), false when nothing was pending (chain stops). Every write goes
 * through saveJob() so a concurrent remove/re-index can't be clobbered/resurrected.
 */
export async function repoAlarmTick(store: RepoStore, engine: RepoEngine, f: RepoFetchers): Promise<boolean> {
	let job: RepoIngestJob | null = null;
	for (const key of await getRepoIndex(store)) {
		const j = await getRepoJob(store, key);
		if (j && j.status !== "done" && j.status !== "error") { job = j; break; }
	}
	if (!job) return false;
	const ref: RepoRef = { owner: job.owner, repo: job.repo };

	try {
		if (job.status === "fetching") {
			const meta = await f.fetchRepoMeta(ref, job.token);
			const tar = await f.fetchRepoTarball(ref, job.branch || meta?.defaultBranch || undefined, job.token);
			const { files, skipped } = f.extractTextFiles(tar, { maxFiles: REPO_MAX_FILES, maxFileBytes: REPO_MAX_FILE_BYTES, maxTotalBytes: REPO_MAX_TOTAL_BYTES });
			if (files.length === 0) {
				await saveJob(store, job, { status: "error", error: "No indexable text files found in this repository.", finishedAt: f.now() });
			} else if (await getRepoJob(store, job.key).then((c) => c?.startedAt === job?.startedAt)) {
				for (let i = 0; i < files.length; i++) await store.put(`rifile:${job.key}:${i}`, files[i]);
				const advanced = await saveJob(store, job, {
					status: "indexing",
					total: files.length,
					done: 0,
					queue: files.map((_, i) => i),
					paths: files.map((file) => file.path),
					skipped,
					description: meta?.description ?? null,
					language: meta?.language ?? null,
					readme: f.findReadme(files),
				});
				if (!advanced) await deleteAll(store, `rifile:${job.key}:`); // superseded after staging
			}
		} else if (job.status === "indexing") {
			const queue = [...job.queue];
			const retry: number[] = [];
			let processed = 0;
			let failed = 0;
			let chunks = 0;
			while (queue.length > 0 && (processed === 0 || chunks < REPO_CHUNK_BUDGET)) {
				const idx = queue.shift() as number;
				const file = await store.get<{ path: string; content: string; attempts?: number }>(`rifile:${job.key}:${idx}`);
				if (file) {
					const n = await engine.vectorizeRepoFile(job.key, file.path, file.content).then((v) => v, () => -1);
					if (n < 0) {
						// Whole-file embed failure (every chunk's embed() returned null — a swallowed
						// Workers-AI hiccup). Retry once on a LATER alarm tick before giving up, rather
						// than permanently dropping the file and calling the repo "Ready" with a hole in
						// its index. A one-tick-later retry usually rides out a transient outage.
						const attempts = (file.attempts ?? 0) + 1;
						if (attempts <= REPO_FILE_MAX_RETRY) {
							await store.put(`rifile:${job.key}:${idx}`, { ...file, attempts });
							retry.push(idx);
						} else {
							failed++;
							await store.delete(`rifile:${job.key}:${idx}`);
						}
					} else {
						if (n > 0) chunks += n;
						await store.delete(`rifile:${job.key}:${idx}`);
					}
				}
				processed++;
			}
			// Retried files aren't done — they go back on the queue and are re-counted next tick,
			// so exclude them from `done` (else it over-counts and can exceed `total`).
			const nextQueue = [...queue, ...retry];
			await saveJob(store, job, {
				done: job.done + (processed - retry.length),
				failed: (job.failed ?? 0) + failed,
				queue: nextQueue,
				status: nextQueue.length === 0 ? "summarizing" : "indexing",
			});
		} else if (job.status === "summarizing") {
			const overview = f.buildRepoOverview(ref, { description: job.description, language: job.language, paths: job.paths, readme: job.readme });
			await engine.vectorizeRepoFile(job.key, "OVERVIEW", overview).catch(() => 0);
			await engine.logEvent("repo.indexed", undefined, { repo: job.key, files: job.total }).catch(() => undefined);
			if (!(await saveJob(store, job, { status: "done", finishedAt: f.now() }))) {
				await engine.clearRepoVectors(job.key).catch(() => undefined); // superseded — drop overview we just wrote
			}
		}
	} catch (err) {
		await saveJob(store, job, { status: "error", error: err instanceof Error ? err.message : String(err), finishedAt: f.now() });
	}
	return true;
}
