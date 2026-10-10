/**
 * The Application Tailor's runner runtime (#956). The CLI process is faked; the envelope check, the
 * workspace confinement, the source reads, the grounding check, the writes, retention and the
 * trace are the real code against a real temp home folder.
 */
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalArtifactTaskEnvelope } from "./contract.js";
import { ARTIFACT_MANIFEST, LocalArtifactRuntime, parseArtifactEnvelope } from "./runtime.js";

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	kill() {
		this.exit(143);
		return true;
	}
	exit(code: number) {
		if (this.exitCode !== null) return;
		this.exitCode = code;
		this.emit("close", code);
	}
}

const RESUME = "Jane Citizen\njane@example.com\nSenior TypeScript Engineer, Acme Pty Ltd, 2019 - 2024\nLed the migration of 40 services to Cloudflare Workers.";
const PROFILE = "Work rights: Australian citizen.\nLocation: Sydney.";

let data: string;
let home: string;
let spawned: Array<{ command: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv }; child: FakeChild }>;
let now: number;

function runtime() {
	return new LocalArtifactRuntime({
		dataDir: data,
		homeDir: home,
		now: () => now,
		spawn: ((command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
			const child = new FakeChild();
			spawned.push({ command, args, opts, child });
			return child;
		}) as never,
	});
}

const LEAD = {
	eventId: "scout-1:lead-1:1",
	sourceInstanceId: "scout-1",
	leadId: "lead-1",
	leadUrl: "https://jobs.example.com/1",
	lifecycleVersion: 1,
	requestedAt: "2026-10-07T00:00:00.000Z",
	lead: { title: "Staff Engineer", company: "Globex", location: "Sydney" },
};

const envelope = (over: Partial<LocalArtifactTaskEnvelope> | Record<string, unknown> = {}): LocalArtifactTaskEnvelope =>
	({
		type: "local_artifact.generate",
		runId: "run-1",
		requestId: "scout-1:lead-1:1",
		instanceId: "tailor-1",
		engine: "claude",
		authMode: "machine",
		workspace: "~/jobs",
		sources: [
			{ role: "resume", path: "resume.md" },
			{ role: "profile", path: "profile.md" },
		],
		lead: LEAD,
		policy: { retainDays: 0, maxMinutes: 10, maxConcurrent: 1 },
		...over,
	}) as LocalArtifactTaskEnvelope;

const GOOD = {
	status: "ready",
	resume_markdown: "# Jane Citizen\njane@example.com\n\nSenior TypeScript Engineer at Acme Pty Ltd (2019 - 2024). Led the migration of 40 services to Cloudflare Workers.",
	cover_letter_markdown: "Dear Globex,\n\nAs an Australian citizen based in Sydney, I led the migration of 40 services to Cloudflare Workers.",
	claims: [
		{ text: "Senior TypeScript Engineer at Acme", source: "resume", quote: "Senior TypeScript Engineer, Acme Pty Ltd" },
		{ text: "Migrated 40 services", source: "resume", quote: "Led the migration of 40 services to Cloudflare Workers." },
		{ text: "Australian citizen", source: "profile", quote: "Work rights: Australian citizen." },
	],
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** The CLI answers with Claude Code's stream-json `result` line, then exits. */
function answer(i: number, draft: unknown, code = 0) {
	const { child } = spawned[i];
	child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init" })}\n`);
	child.stdout.write(`${JSON.stringify({ type: "result", result: typeof draft === "string" ? draft : `\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`` })}\n`);
	child.exit(code);
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const jobs = () => join(home, "jobs");

beforeEach(() => {
	data = mkdtempSync(join(tmpdir(), "la-data-"));
	home = mkdtempSync(join(tmpdir(), "la-home-"));
	mkdirSync(jobs());
	writeFileSync(join(jobs(), "resume.md"), RESUME);
	writeFileSync(join(jobs(), "profile.md"), PROFILE);
	spawned = [];
	now = Date.parse("2026-10-07T00:00:00Z");
});
afterEach(() => {
	rmSync(data, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

describe("a tailoring run", () => {
	it("writes a résumé and a cover letter into a fresh run folder, by handle, from verified claims", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		expect(spawned).toHaveLength(1);
		answer(0, GOOD);
		await settle();
		const s = rt.status({ runId: "run-1" });
		expect(s.state).toBe("ended");
		expect(s.result).toMatchObject({ outcome: "completed", engineAuth: "machine-login", traceId: "run-1" });
		expect(s.result?.artifacts.map((a) => a.path)).toEqual(["~/jobs/applications/lead-1/run-1/resume.md", "~/jobs/applications/lead-1/run-1/cover-letter.md"]);
		expect(s.result?.artifacts).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "resume", path: "~/jobs/applications/lead-1/run-1/resume.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number) }),
			expect.objectContaining({ kind: "cover_letter", path: "~/jobs/applications/lead-1/run-1/cover-letter.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number) }),
		]));
		const dir = join(jobs(), "applications", "lead-1", "run-1");
		expect(readFileSync(join(dir, "resume.md"), "utf8")).toContain("Senior TypeScript Engineer");
		expect(JSON.parse(readFileSync(join(dir, ARTIFACT_MANIFEST), "utf8"))).toMatchObject({ runId: "run-1", leadId: "lead-1", eventId: "scout-1:lead-1:1", retainUntil: null });
		expect(s.result?.sourceHashes.map((h) => h.role)).toEqual(["resume", "profile"]);
		expect(s.result?.profileVersion).toMatch(/^[a-f0-9]{16}$/);
		// Masters untouched.
		expect(readFileSync(join(jobs(), "resume.md"), "utf8")).toBe(RESUME);
		expect(readFileSync(join(jobs(), "profile.md"), "utf8")).toBe(PROFILE);
		// The trace names handles, never content.
		const trace = JSON.stringify(s.events);
		expect(trace).not.toContain("Cloudflare Workers");
		expect(trace).not.toContain("jane@example.com");
		expect(s.events.map((e) => e.type)).toEqual(["source.read", "source.read", "engine.auth_checked", "engine.started", "engine.ended", "claims.checked", "artifact.written", "artifact.written"]);
	});

	it("materializes only the exact uploaded extracted texts under fixed scratch paths, never local masters", async () => {
		const uploadedResume = RESUME.replace("Jane Citizen", "Synthetic Uploaded Candidate");
		const uploadedProfile = PROFILE;
		rmSync(join(jobs(), "resume.md"));
		rmSync(join(jobs(), "profile.md"));
		const rt = runtime();
		rt.start(envelope({
			uploadedSources: [
				{ role: "resume", fileId: "fixture_resume", version: "v1", originalSha256: "a".repeat(64), extractedTextSha256: hash(uploadedResume), extractedAt: "2026-10-07T00:00:00.000Z", text: uploadedResume },
				{ role: "profile", fileId: "fixture_profile", version: "v1", originalSha256: "b".repeat(64), extractedTextSha256: hash(uploadedProfile), extractedAt: "2026-10-07T00:00:00.000Z", text: uploadedProfile },
			],
		}));
		await settle();
		expect(spawned).toHaveLength(1);
		expect(readFileSync(join(data, "local-artifact", "tailor-1", "run-1", "sources", "resume.txt"), "utf8")).toBe(uploadedResume);
		expect(readFileSync(join(data, "local-artifact", "tailor-1", "run-1", "sources", "profile.txt"), "utf8")).toBe(uploadedProfile);
		const status = rt.status({ runId: "run-1" });
		expect(status.events.filter((event) => event.type === "source.read").map((event) => event.detail?.path)).toEqual(["uploaded/fixture_resume@v1", "uploaded/fixture_profile@v1"]);
		expect(JSON.stringify(status.events)).not.toContain("Synthetic Uploaded Candidate");
	});

	it("cleans uploaded text immediately after a terminal run while preserving provenance-only audit", async () => {
		const rt = runtime();
		rt.start(envelope({
			uploadedSources: [
				{ role: "resume", fileId: "fixture_resume", version: "v1", originalSha256: "a".repeat(64), extractedTextSha256: hash(RESUME), extractedAt: "2026-10-07T00:00:00.000Z", text: RESUME },
				{ role: "profile", fileId: "fixture_profile", version: "v1", originalSha256: "b".repeat(64), extractedTextSha256: hash(PROFILE), extractedAt: "2026-10-07T00:00:00.000Z", text: PROFILE },
			],
		}));
		await settle();
		answer(0, GOOD);
		await settle();
		const status = rt.status({ runId: "run-1" });
		expect(status.result).toMatchObject({ outcome: "completed", sourceHashes: [
			expect.objectContaining({ role: "resume", path: "uploaded/fixture_resume@v1", sha256: hash(RESUME) }),
			expect.objectContaining({ role: "profile", path: "uploaded/fixture_profile@v1", sha256: hash(PROFILE) }),
		] });
		expect(existsSync(join(data, "local-artifact", "tailor-1", "run-1", "sources"))).toBe(false);
		expect(JSON.stringify(status)).not.toContain("Jane Citizen");
	});

	it("refuses an uploaded text whose hash does not match its selected provenance", () => {
		expect(() => parseArtifactEnvelope(envelope({
			uploadedSources: [
				{ role: "resume", fileId: "fixture_resume", version: "v1", originalSha256: "a".repeat(64), extractedTextSha256: "b".repeat(64), extractedAt: "2026-10-07T00:00:00.000Z", text: RESUME },
				{ role: "profile", fileId: "fixture_profile", version: "v1", originalSha256: "c".repeat(64), extractedTextSha256: hash(PROFILE), extractedAt: "2026-10-07T00:00:00.000Z", text: PROFILE },
			],
		}))).toThrow(/does not match/);
	});

	it("runs the CLI with no tools, in an empty scratch folder, and never with a provider API key", async () => {
		const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, t: process.env.CLAUDE_CODE_OAUTH_TOKEN };
		process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-the-cli-000000";
		process.env.OPENAI_API_KEY = "sk-openai-should-never-reach-the-cli-0000";
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-token-machine-mode-drops-it";
		try {
			const rt = runtime();
			rt.start(envelope());
			rt.start(envelope({ runId: "run-2", requestId: "r2", instanceId: "tailor-2", engine: "codex", authMode: "subscription" }));
			await settle();
			const [claude, codex] = spawned;
			expect(claude.command).toBe("claude");
			expect(claude.args).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config"]));
			expect(claude.args).not.toContain("--mcp-config");
			expect(codex.command).toBe("codex");
			expect(codex.args).toEqual(expect.arrayContaining(["--sandbox", "read-only", "--ignore-user-config"]));
			for (const s of spawned) {
				expect(s.opts.env.ANTHROPIC_API_KEY).toBeUndefined();
				expect(s.opts.env.OPENAI_API_KEY).toBeUndefined();
				expect(readdirSync(s.opts.cwd)).toEqual([]);
				expect(s.opts.cwd.startsWith(data)).toBe(true);
			}
			// machine mode drops the subscription token too, so the CLI's own login is what runs.
			expect(claude.opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
			expect(rt.status({ runId: "run-1" }).events.find((e) => e.type === "engine.auth_checked")?.detail).toMatchObject({ engineAuth: "machine-login" });
		} finally {
			for (const [k, v] of [["ANTHROPIC_API_KEY", saved.a], ["OPENAI_API_KEY", saved.o], ["CLAUDE_CODE_OAUTH_TOKEN", saved.t]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("is replay-safe: the same requestId is the same run", async () => {
		const rt = runtime();
		const a = rt.start(envelope());
		const b = rt.start(envelope({ runId: "run-other" }));
		expect(b).toMatchObject({ runId: a.runId, existing: true });
		await settle();
		expect(spawned).toHaveLength(1);
	});
});

describe("it pauses instead of guessing", () => {
	const ended = async (rt: LocalArtifactRuntime, runId = "run-1") => {
		await settle();
		return rt.status({ runId }).result;
	};

	it("on a missing source — no CLI, no folder", async () => {
		rmSync(join(jobs(), "profile.md"));
		const rt = runtime();
		rt.start(envelope());
		const r = await ended(rt);
		expect(r).toMatchObject({ outcome: "needs_human", blockReason: "missing_source" });
		expect(r?.questions?.[0]).toContain("~/jobs/profile.md");
		expect(spawned).toHaveLength(0);
		expect(existsSync(join(jobs(), "applications"))).toBe(false);
	});

	it("on a source that is not configured at all", async () => {
		const rt = runtime();
		rt.start(envelope({ sources: [{ role: "resume", path: "resume.md" }] }));
		expect(await ended(rt)).toMatchObject({ outcome: "needs_human", blockReason: "missing_source" });
	});

	it("on a source that symlinks out of the workspace", async () => {
		const secret = join(home, "secret.txt");
		writeFileSync(secret, "not for the CLI");
		rmSync(join(jobs(), "profile.md"));
		symlinkSync(secret, join(jobs(), "profile.md"));
		const rt = runtime();
		rt.start(envelope());
		expect(await ended(rt)).toMatchObject({ outcome: "needs_human", blockReason: "missing_source" });
		expect(spawned).toHaveLength(0);
	});

	it("on a malformed lead", async () => {
		const rt = runtime();
		rt.start(envelope({ lead: { ...LEAD, lead: {} } as never }));
		const r = await ended(rt);
		expect(r).toMatchObject({ outcome: "needs_human", blockReason: "malformed_lead" });
		expect(spawned).toHaveLength(0);
	});

	it("on a workspace that resolves outside home", async () => {
		const outside = mkdtempSync(join(tmpdir(), "la-outside-"));
		rmSync(jobs(), { recursive: true });
		symlinkSync(outside, jobs());
		const rt = runtime();
		rt.start(envelope());
		expect(await ended(rt)).toMatchObject({ outcome: "needs_human", blockReason: "workspace_unavailable" });
		rmSync(outside, { recursive: true, force: true });
	});

	it("on a claim whose quote is not in the named source — and writes nothing", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		answer(0, { ...GOOD, claims: [...GOOD.claims, { text: "PhD in Computer Science", source: "resume", quote: "PhD, University of Sydney" }] });
		const r = await ended(rt);
		expect(r).toMatchObject({ outcome: "needs_human", blockReason: "uncertain_claim", artifacts: [] });
		expect(r?.questions?.join(" ")).toContain("PhD in Computer Science");
		expect(existsSync(join(jobs(), "applications", "lead-1", "run-1"))).toBe(false);
	});

	it("accepts fenced application JSON surrounded by prose and malformed braces", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		answer(0, `I prepared this {not JSON}.\n\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`\nDone.`);
		await settle();
		expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "completed" });
	});

	it("records safe structured diagnostics for two failed retry attempts", async () => {
		const rt = runtime();
		rt.start(envelope({ runId: "run-2", requestId: "scout-1:lead-1:1:retry:2" }));
		await settle();
		answer(0, "The model returned prose instead of application JSON.");
		await settle();
		const first = rt.status({ runId: "run-2" });
		expect(first.result).toMatchObject({ outcome: "needs_human", blockReason: "invalid_cli_output", diagnostic: { validationError: "no_json_object", parseAttempts: ["fenced_json", "balanced_object"], runId: "run-2", attemptNumber: 2 } });
		expect(first.events.find((event) => event.type === "claims.checked")?.detail).toMatchObject({ validationError: "no_json_object", runId: "run-2", attemptNumber: 2 });

		rt.start(envelope({ runId: "run-3", requestId: "scout-1:lead-1:1:retry:3" }));
		await settle();
		answer(1, "```json\n{broken}\n```");
		await settle();
		const second = rt.status({ runId: "run-3" });
		expect(second.result).toMatchObject({ outcome: "needs_human", blockReason: "invalid_cli_output", diagnostic: { validationError: "invalid_json", runId: "run-3", attemptNumber: 3 } });
		expect(JSON.stringify(second.events)).not.toContain("The model returned prose");
	});

	it("on an invented year, email or phone number, even when every claim cites a real quote", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		answer(0, { ...GOOD, resume_markdown: `${GOOD.resume_markdown}\nPhone +61 400 111 222. Certified 2015. jane.c@other.com` });
		const r = await ended(rt);
		expect(r).toMatchObject({ outcome: "needs_human", blockReason: "uncertain_claim" });
		expect(r?.questions).toHaveLength(3);
	});

	it("when the CLI itself asks for information", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		answer(0, { status: "needs_human", questions: ["What salary range should the cover letter mention, if any?"] });
		expect(await ended(rt)).toMatchObject({ outcome: "needs_human", blockReason: "missing_information", questions: ["What salary range should the cover letter mention, if any?"] });
	});

	it("when the CLI is not signed in", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		spawned[0].child.stderr.write("Error: Not logged in · Please run /login\n");
		spawned[0].child.exit(1);
		expect(await ended(rt)).toMatchObject({ outcome: "needs_human", blockReason: "engine_not_signed_in", engineAuth: "missing_login" });
	});
});

describe("the envelope is checked at the runner's boundary", () => {
	it.each([
		["a traversing source", { sources: [{ role: "resume", path: "../.ssh/id_rsa" }] }],
		["an absolute source", { sources: [{ role: "resume", path: "/etc/passwd" }] }],
		["a source among generated material", { sources: [{ role: "resume", path: "applications/other-lead/run/resume.md" }] }],
		["a workspace outside home", { workspace: "/tmp/jobs" }],
		["an api-key auth mode", { authMode: "api-key" }],
		["a runId that is not a folder name", { runId: "../run" }],
	])("refuses %s", (_, over) => {
		expect(() => parseArtifactEnvelope(envelope(over))).toThrow(/Invalid local artifact task/);
	});
});

describe("retention", () => {
	it("removes a generated folder past its date on the next run, and never the owner's own folders", async () => {
		const rt = runtime();
		rt.start(envelope({ policy: { retainDays: 1, maxMinutes: 10, maxConcurrent: 1 } }));
		await settle();
		answer(0, GOOD);
		await settle();
		const done = join(jobs(), "applications", "lead-1", "run-1");
		expect(existsSync(done)).toBe(true);
		const mine = join(jobs(), "applications", "lead-1", "my-notes");
		mkdirSync(mine);
		now += 2 * 86_400_000;
		rt.start(envelope({ runId: "run-2", requestId: "r2" }));
		await settle();
		expect(existsSync(done)).toBe(false);
		expect(existsSync(mine)).toBe(true);
		expect(rt.status({ runId: "run-2" }).events.find((e) => e.type === "retention.swept")?.detail).toEqual({ removed: 1 });
	});
});
