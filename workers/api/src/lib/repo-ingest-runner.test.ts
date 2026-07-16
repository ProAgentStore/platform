import { describe, expect, it, vi } from "vitest";
import {
	addRepo,
	getRepoJob,
	REPO_MAX_REPOS,
	removeRepo,
	repoAlarmTick,
	type RepoEngine,
	type RepoFetchers,
	type RepoStore,
	saveJob,
	statusList,
} from "./repo-ingest-runner.js";
import type { ExtractedFile } from "./repo-ingest.js";

function memStore() {
	const m = new Map<string, unknown>();
	const store: RepoStore & { _m: Map<string, unknown> } = {
		_m: m,
		async get<T>(k: string) { return (m.get(k) as T) ?? null; },
		async put(k: string, v: unknown) { m.set(k, v); },
		async delete(k: string | string[]) { const keys = Array.isArray(k) ? k : [k]; for (const x of keys) m.delete(x); return true; },
		async list<T>(opts?: { prefix?: string }) {
			return new Map([...m.entries()].filter(([k]) => !opts?.prefix || k.startsWith(opts.prefix))) as Map<string, T>;
		},
	};
	return store;
}

/** Fake engine: records vectorized files; can be told to throw for a path. */
function fakeEngine(throwOnPath?: string) {
	const vectorized: string[] = [];
	const cleared: Array<string | undefined> = [];
	const engine: RepoEngine & { vectorized: string[]; cleared: Array<string | undefined> } = {
		vectorized,
		cleared,
		async vectorizeRepoFile(key, path) {
			if (path === throwOnPath) throw new Error("embed boom");
			vectorized.push(`${key}::${path}`);
			return 2;
		},
		async clearRepoVectors(key) { cleared.push(key); },
		async logEvent() { return undefined; },
	};
	return engine;
}

function fakeFetchers(files: ExtractedFile[], over?: Partial<RepoFetchers>): RepoFetchers {
	let t = 0;
	return {
		async fetchRepoMeta() { return { description: "a repo", defaultBranch: "main", language: "TypeScript", stars: 1, private: false }; },
		async fetchRepoTarball() { return new Uint8Array([1, 2, 3]); },
		extractTextFiles() { return { files, skipped: 0 }; },
		buildRepoOverview() { return "# overview\nfile tree etc."; },
		findReadme() { return "# readme"; },
		now: () => `t${++t}`,
		...over,
	};
}

const FILES: ExtractedFile[] = [
	{ path: "src/a.ts", content: "export const a = 1; // module a with enough text to index" },
	{ path: "src/b.ts", content: "export const b = 2; // module b with enough text to index" },
];

async function drain(store: RepoStore, engine: RepoEngine, f: RepoFetchers, max = 50) {
	let n = 0;
	while (await repoAlarmTick(store, engine, f)) if (++n > max) throw new Error("tick loop did not terminate");
	return n;
}

describe("repo-ingest-runner", () => {
	const ref = { owner: "octo", repo: "demo" };

	it("runs the full lifecycle fetching → indexing → summarizing → done", async () => {
		const store = memStore();
		const engine = fakeEngine();
		const f = fakeFetchers(FILES);

		const { job } = await addRepo(store, engine, { ref, repoUrl: "https://github.com/octo/demo", now: "t0" });
		expect(job?.status).toBe("fetching");

		await drain(store, engine, f);

		const final = await getRepoJob(store, "octo/demo");
		expect(final?.status).toBe("done");
		expect(final?.total).toBe(2);
		expect(final?.done).toBe(2);
		// Each file + the overview were vectorized, namespaced by repo.
		expect(engine.vectorized).toContain("octo/demo::src/a.ts");
		expect(engine.vectorized).toContain("octo/demo::src/b.ts");
		expect(engine.vectorized).toContain("octo/demo::OVERVIEW");
		// Staged files cleaned up.
		expect([...store._m.keys()].some((k) => k.startsWith("rifile:"))).toBe(false);
	});

	it("indexes multiple repos, one at a time, until all done", async () => {
		const store = memStore();
		const engine = fakeEngine();
		const f = fakeFetchers(FILES);

		await addRepo(store, engine, { ref: { owner: "octo", repo: "one" }, repoUrl: "octo/one", now: "a" });
		await addRepo(store, engine, { ref: { owner: "octo", repo: "two" }, repoUrl: "octo/two", now: "b" });
		await drain(store, engine, f);

		expect((await getRepoJob(store, "octo/one"))?.status).toBe("done");
		expect((await getRepoJob(store, "octo/two"))?.status).toBe("done");
		const repos = await statusList(store);
		expect(repos).toHaveLength(2);
	});

	it("errors a repo with no indexable files (and the chain continues)", async () => {
		const store = memStore();
		const engine = fakeEngine();
		const f = fakeFetchers([]); // nothing to index
		await addRepo(store, engine, { ref, repoUrl: "octo/demo", now: "t0" });
		await drain(store, engine, f);
		const job = await getRepoJob(store, "octo/demo");
		expect(job?.status).toBe("error");
		expect(job?.error).toMatch(/no indexable/i);
	});

	it("counts files whose embedding throws as failed, but still finishes", async () => {
		const store = memStore();
		const engine = fakeEngine("src/a.ts"); // a.ts embedding throws
		const f = fakeFetchers(FILES);
		await addRepo(store, engine, { ref, repoUrl: "octo/demo", now: "t0" });
		await drain(store, engine, f);
		const job = await getRepoJob(store, "octo/demo");
		expect(job?.status).toBe("done");
		expect(job?.failed).toBe(1);
		expect(engine.vectorized).toContain("octo/demo::src/b.ts"); // b still indexed
	});

	it("retries a transient whole-file embed failure and recovers (failed:0)", async () => {
		const store = memStore();
		// a.ts fails (returns -1) the first time it's seen, then succeeds on retry.
		const seen = new Set<string>();
		const vectorized: string[] = [];
		const engine: RepoEngine & { vectorized: string[] } = {
			vectorized,
			async vectorizeRepoFile(key, path) {
				if (path === "src/a.ts" && !seen.has(path)) { seen.add(path); return -1; }
				vectorized.push(`${key}::${path}`);
				return 2;
			},
			async clearRepoVectors() {},
			async logEvent() { return undefined; },
		};
		const f = fakeFetchers(FILES);
		await addRepo(store, engine, { ref, repoUrl: "octo/demo", now: "t0" });
		await drain(store, engine, f);
		const job = await getRepoJob(store, "octo/demo");
		expect(job?.status).toBe("done");
		expect(job?.failed).toBe(0); // recovered on retry, not dropped
		expect(job?.done).toBe(2); // not over-counted despite the retry
		expect(vectorized).toContain("octo/demo::src/a.ts"); // eventually indexed
		expect([...store._m.keys()].some((k) => k.startsWith("rifile:"))).toBe(false);
	});

	it("saveJob refuses to write a superseded job (re-index race)", async () => {
		const store = memStore();
		const engine = fakeEngine();
		await addRepo(store, engine, { ref, repoUrl: "octo/demo", now: "t1" });
		const stale = await getRepoJob(store, "octo/demo"); // startedAt t1
		// Re-index → fresh job with a new startedAt.
		await addRepo(store, engine, { ref, repoUrl: "octo/demo", now: "t2" });

		const ok = await saveJob(store, stale!, { status: "done" });
		expect(ok).toBe(false);
		// The fresh job is untouched.
		expect((await getRepoJob(store, "octo/demo"))?.startedAt).toBe("t2");
		expect((await getRepoJob(store, "octo/demo"))?.status).toBe("fetching");
	});

	it("a stale tick cannot resurrect a removed repo", async () => {
		const store = memStore();
		const engine = fakeEngine();
		const f = fakeFetchers(FILES);
		await addRepo(store, engine, { ref, repoUrl: "octo/demo", now: "t1" });
		await repoAlarmTick(store, engine, f); // → indexing
		const stale = await getRepoJob(store, "octo/demo");

		await removeRepo(store, engine, "octo/demo"); // user removes mid-ingest

		// A late write from the in-flight tick must NOT recreate the job.
		const ok = await saveJob(store, stale!, { status: "summarizing" });
		expect(ok).toBe(false);
		expect(await getRepoJob(store, "octo/demo")).toBeNull();
		expect(await repoAlarmTick(store, engine, f)).toBe(false); // nothing pending
	});

	it("removeRepo(key) clears one repo; others remain", async () => {
		const store = memStore();
		const engine = fakeEngine();
		const f = fakeFetchers(FILES);
		await addRepo(store, engine, { ref: { owner: "octo", repo: "one" }, repoUrl: "octo/one", now: "a" });
		await addRepo(store, engine, { ref: { owner: "octo", repo: "two" }, repoUrl: "octo/two", now: "b" });
		await drain(store, engine, f);

		await removeRepo(store, engine, "octo/one");

		expect(await getRepoJob(store, "octo/one")).toBeNull();
		expect((await getRepoJob(store, "octo/two"))?.status).toBe("done");
		expect(engine.cleared).toContain("octo/one");
		expect(await statusList(store)).toHaveLength(1);
	});

	it("enforces the repo cap but allows re-indexing an existing repo at the cap", async () => {
		const store = memStore();
		const engine = fakeEngine();
		for (let i = 0; i < REPO_MAX_REPOS; i++) {
			const r = await addRepo(store, engine, { ref: { owner: "o", repo: `r${i}` }, repoUrl: `o/r${i}`, now: `t${i}` });
			expect(r.job).toBeDefined();
		}
		// One more NEW repo is rejected.
		const over = await addRepo(store, engine, { ref: { owner: "o", repo: "extra" }, repoUrl: "o/extra", now: "x" });
		expect(over.error).toMatch(/limit/i);
		// Re-indexing one that already exists is fine.
		const reindex = await addRepo(store, engine, { ref: { owner: "o", repo: "r0" }, repoUrl: "o/r0", now: "y" });
		expect(reindex.job).toBeDefined();
	});

	it("statusList strips secrets and self-heals stale memory when empty", async () => {
		const store = memStore();
		const engine = fakeEngine();
		await addRepo(store, engine, { ref, repoUrl: "octo/demo", token: "ghs_secret", now: "t1" });
		const [pub] = await statusList(store);
		expect(pub.key).toBe("octo/demo");
		expect((pub as Record<string, unknown>).token).toBeUndefined();
		expect((pub as Record<string, unknown>).queue).toBeUndefined();

		// Empty instance with a leftover legacy memory entry → self-healed.
		const empty = memStore();
		await empty.put("mem:repository", { content: "Indexed repository ghost" });
		await empty.put("repoIngest", { legacy: true });
		expect(await statusList(empty)).toHaveLength(0);
		expect(await empty.get("mem:repository")).toBeNull();
		expect(await empty.get("repoIngest")).toBeNull();
	});
});
