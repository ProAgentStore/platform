/**
 * The browser-run screenshot contract (#1063), over the real schema with an in-memory R2: keying, the
 * size cap, idempotence, the closed metadata, the pull from a runner, and retention.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";
import { MAX_BROWSER_ARTIFACT_BYTES, artifactMetadata, browserArtifactKey, captionUrl, ingestRunnerShots, listBrowserArtifacts, putBrowserArtifact, storeWorkflowShot, subjectScreenshotsOff, sweepExpiredBrowserArtifacts } from "./browser-artifacts.js";

class FakeR2 {
	objects = new Map<string, Uint8Array>();
	deleted: string[] = [];
	async put(key: string, value: Uint8Array) {
		this.objects.set(key, value);
	}
	async get(key: string) {
		const v = this.objects.get(key);
		return v ? { body: v } : null;
	}
	async delete(key: string) {
		this.deleted.push(key);
		this.objects.delete(key);
	}
}

let d1: RealSchemaD1;
let r2: FakeR2;
let env: Env;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const rows = () => d1.sqlite.prepare("SELECT * FROM browser_run_artifacts ORDER BY seq").all() as Array<Record<string, unknown>>;

beforeEach(() => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login) VALUES ('u1', 'u1'), ('u2', 'u2')`);
	r2 = new FakeR2();
	env = { DB: d1.DB, STORAGE: r2 } as unknown as Env;
});
afterEach(() => d1.close());

const put = (seq: number, over: Partial<Parameters<typeof putBrowserArtifact>[1]> = {}) =>
	putBrowserArtifact(env, { userId: "u1", instanceId: "i1", subjectKind: "local_browser_run", subjectId: "run-1", seq, bytes: JPEG, metadata: { point: "navigated", url: "https://au.seek.com/job/1?tracking=SECRET#frag" }, ...over });

describe("keys and metadata", () => {
	it("keys a frame by owner, instance, subject and a zero-padded seq", () => {
		expect(browserArtifactKey("u1", "i1", "local_apply_run", "run-9", 7)).toBe("browser-artifacts/u1/i1/local_apply_run/run-9/00007.jpg");
	});

	it("keeps a URL without its query, fragment or credentials — they carry tokens and search terms", () => {
		expect(captionUrl("https://user:pw@au.seek.com/job/1?tracking=SECRET&q=x#frag")).toEqual({ url: "https://au.seek.com/job/1", domain: "au.seek.com" });
		expect(captionUrl("javascript:alert(1)")).toEqual({ url: null, domain: null });
	});

	it("closes the metadata: an unknown point is `action`, a free-text action is dropped", () => {
		expect(artifactMetadata({ point: "typed:hunter2", action: "Typed my password hunter2" })).toEqual({ point: "action", url: null, domain: null, action: null });
	});
});

describe("putBrowserArtifact", () => {
	it("stores the bytes in R2 and one metadata row — and only the stripped URL", async () => {
		const out = await put(1);
		expect(out).toMatchObject({ stored: true, artifact: { seq: 1, point: "navigated", url: "https://au.seek.com/job/1", domain: "au.seek.com", contentType: "image/jpeg", bytes: JPEG.byteLength } });
		expect(r2.objects.get("browser-artifacts/u1/i1/local_browser_run/run-1/00001.jpg")).toEqual(JPEG);
		expect(JSON.stringify(rows())).not.toMatch(/SECRET|frag/);
	});

	it("is idempotent per subject and seq — a re-sync never stores a frame twice", async () => {
		const a = await put(1);
		const b = await put(1);
		expect(b.stored && a.stored && b.artifact.id).toBe(a.stored && a.artifact.id);
		expect(rows()).toHaveLength(1);
	});

	it("refuses an oversized, empty or non-image frame without writing anything", async () => {
		expect(await put(2, { bytes: new Uint8Array(MAX_BROWSER_ARTIFACT_BYTES + 1) })).toEqual({ stored: false, reason: "too_large" });
		expect(await put(3, { bytes: new Uint8Array() })).toEqual({ stored: false, reason: "empty" });
		expect(await put(4, { contentType: "text/html" })).toEqual({ stored: false, reason: "bad_type" });
		expect(r2.objects.size).toBe(0);
		expect(rows()).toHaveLength(0);
	});

	it("a frame whose row cannot be written leaves no R2 object behind — nothing a sweep could never find", async () => {
		expect(await put(9, { userId: "nobody" })).toEqual({ stored: false, reason: "write_failed" });
		expect(r2.objects.size).toBe(0);
	});

	it("a workflow step's shot is stored under its task, and returns the id its event carries", async () => {
		const id = await storeWorkflowShot(env, { userId: "u1", instanceId: "i1", taskId: "task-1", seq: 4, screenshotBase64: b64(JPEG), action: "click", url: "https://ats.example/apply?token=SECRET" });
		expect(id).toEqual(expect.any(String));
		expect(rows()[0]).toMatchObject({ id, subject_kind: "runtime_task", subject_id: "task-1", seq: 4, point: "action", action: "click", url: "https://ats.example/apply" });
		expect(await storeWorkflowShot(env, { userId: "u1", instanceId: "i1", taskId: "task-1", seq: 5, screenshotBase64: "not base64!", action: "click", url: "" })).toBeNull();
	});
});

describe("the storage guard — a run started with screenshots OFF never gets a frame stored (#1064)", () => {
	/** One run of each kind, its own record carrying the switch as it stood when it started. */
	const seed = (off: boolean) => {
		const policy = JSON.stringify(off ? { engine: "claude", screenshots: false } : { engine: "claude" });
		const input = JSON.stringify({ input: off ? { url: "https://ats.example", screenshots: false } : { url: "https://ats.example" } });
		d1.exec(`INSERT INTO agents (id, owner_id, slug, name) VALUES ('a1', 'u1', 'a1', 'A'); INSERT INTO agent_instances (id, agent_id, user_id) VALUES ('i1', 'a1', 'u1')`);
		d1.exec(`INSERT INTO local_browser_runs (id, instance_id, user_id, request_id, objective, policy, created_at, updated_at) VALUES ('lb', 'i1', 'u1', 'r1', 'x', '${policy}', 0, 0)`);
		d1.exec(`INSERT INTO local_apply_runs (id, instance_id, user_id, application_id, request_id, policy, created_at, updated_at) VALUES ('la', 'i1', 'u1', 'app', 'r2', '${policy}', 0, 0)`);
		d1.exec(`INSERT INTO instance_runtime_tasks (id, instance_id, user_id, type, status, payload, created_at, updated_at) VALUES ('rt', 'i1', 'u1', 'browser.task', 'running', '${input}', 0, 0)`);
	};
	const subjects = [["local_browser_run", "lb"], ["local_apply_run", "la"], ["runtime_task", "rt"]] as const;

	it.each(subjects)("%s: refused with `screenshots_off`, nothing in R2 or D1", async (kind, id) => {
		seed(true);
		expect(await subjectScreenshotsOff(env, "u1", kind, id)).toBe(true);
		expect(await put(1, { subjectKind: kind, subjectId: id })).toEqual({ stored: false, reason: "screenshots_off" });
		expect(r2.objects.size).toBe(0);
		expect(rows()).toHaveLength(0);
	});

	it.each(subjects)("%s: a run that started ON (or recorded nothing) stores as before", async (kind, id) => {
		seed(false);
		expect(await subjectScreenshotsOff(env, "u1", kind, id)).toBe(false);
		expect(await put(1, { subjectKind: kind, subjectId: id })).toMatchObject({ stored: true });
	});

	it("the pull and the workflow writer both stop at the guard, whatever a runner sends", async () => {
		seed(true);
		const frame = { seq: 1, point: "navigated", url: "https://au.seek.com/", mimeType: "image/jpeg", data: b64(JPEG), at: "2026-10-14T00:00:00Z" };
		expect(await ingestRunnerShots(env, { userId: "u1", instanceId: "i1", subjectKind: "local_apply_run", subjectId: "la" }, async (after) => (after === 0 ? { shots: [frame], lastSeq: 1 } : null))).toBe(0);
		expect(await storeWorkflowShot(env, { userId: "u1", instanceId: "i1", taskId: "rt", seq: 1, screenshotBase64: b64(JPEG), action: "click", url: "" })).toBeNull();
		expect(r2.objects.size).toBe(0);
	});

	it("another owner's run of the same id does not count as off for this owner", async () => {
		seed(true);
		expect(await subjectScreenshotsOff(env, "u2", "local_browser_run", "lb")).toBe(false);
	});
});

describe("ingestRunnerShots — the cloud pulls a run's frames (the runner cannot push)", () => {
	const shot = (seq: number, extra: Record<string, unknown> = {}) => ({ seq, point: "clicked", url: "https://au.seek.com/job/1?x=1", mimeType: "image/jpeg", data: b64(JPEG), at: "2026-10-14T00:00:00Z", ...extra });

	it("stores every page of frames, resumes after the last stored one, and keeps the run's own retention", async () => {
		const asked: number[] = [];
		const pages: Record<number, unknown> = { 0: { shots: [shot(1), shot(2)], lastSeq: 2 }, 2: { shots: [shot(3)], lastSeq: 3 }, 3: { shots: [], lastSeq: 3 } };
		const stored = await ingestRunnerShots(env, { userId: "u1", instanceId: "i1", subjectKind: "local_browser_run", subjectId: "run-1", retentionDays: 7 }, async (after) => {
			asked.push(after);
			return pages[after];
		}, 1_000);
		expect(stored).toBe(3);
		expect(asked).toEqual([0, 2, 3]);
		expect(rows().map((r) => r.seq)).toEqual([1, 2, 3]);
		expect(rows()[0]).toMatchObject({ expires_at: 1_000 + 7 * 86_400_000 });
		// The next sync asks only for what is new.
		asked.length = 0;
		await ingestRunnerShots(env, { userId: "u1", instanceId: "i1", subjectKind: "local_browser_run", subjectId: "run-1" }, async (after) => {
			asked.push(after);
			return { shots: [], lastSeq: after };
		});
		expect(asked).toEqual([3]);
	});

	it("an old runner without the route is simply 'no frames'", async () => {
		expect(await ingestRunnerShots(env, { userId: "u1", instanceId: "i1", subjectKind: "local_apply_run", subjectId: "run-2" }, async () => null)).toBe(0);
		expect(await ingestRunnerShots(env, { userId: "u1", instanceId: "i1", subjectKind: "local_apply_run", subjectId: "run-2" }, async () => {
			throw new Error("404");
		})).toBe(0);
	});

	it("skips a frame that is not base64, or one the runner already sent", async () => {
		await ingestRunnerShots(env, { userId: "u1", instanceId: "i1", subjectKind: "local_apply_run", subjectId: "run-3" }, async (after) => (after === 0 ? { shots: [shot(1, { data: "%%%" }), shot(2)], lastSeq: 2 } : null));
		expect(rows().map((r) => r.seq)).toEqual([2]);
	});
});

describe("retention", () => {
	it("deletes the R2 object and its row once expired — and never a legacy runshot/ object", async () => {
		await put(1, { now: 0, retentionDays: 1 });
		await put(2, { now: Date.now(), retentionDays: 30 });
		r2.objects.set("runshot/u1/i1/task-old/00001.jpg", JPEG);
		expect(await sweepExpiredBrowserArtifacts(env, 2 * 86_400_000)).toBe(1);
		expect(rows().map((r) => r.seq)).toEqual([2]);
		expect(r2.deleted).toEqual(["browser-artifacts/u1/i1/local_browser_run/run-1/00001.jpg"]);
		expect(r2.objects.has("runshot/u1/i1/task-old/00001.jpg")).toBe(true);
	});

	it("a failed R2 delete keeps the row, so the next sweep retries it", async () => {
		await put(1, { now: 0, retentionDays: 1 });
		r2.delete = async () => {
			throw new Error("R2 down");
		};
		expect(await sweepExpiredBrowserArtifacts(env, 2 * 86_400_000)).toBe(0);
		expect(rows()).toHaveLength(1);
	});

	it("lists a subject's frames for its owner only", async () => {
		await put(1);
		expect(await listBrowserArtifacts(env, "u1", "i1", "local_browser_run", "run-1")).toHaveLength(1);
		expect(await listBrowserArtifacts(env, "u2", "i1", "local_browser_run", "run-1")).toHaveLength(0);
	});
});
