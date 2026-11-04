/** Current owner preferences guide drafts without rewriting the immutable source evidence (#1508). */
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { InstancePreferences } from "../instance-preferences-contract.js";
import { ARTIFACT_MANIFEST, LocalArtifactRuntime } from "./runtime.js";

const NOW = Date.parse("2026-11-04T00:00:00Z");
const PROFILE = "Work rights: Australian citizen.\nSalary expectation: AUD 180,000.\nLocation: Sydney.";
const ANSWERS = "Preferred employment type: Contract.\nAvailable: immediately.";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const preferences = (): InstancePreferences => ({ version: 1, source: "user", instanceId: "tailor-1", memoryKey: "job_application_preferences", memoryUpdatedAt: "2026-11-04T00:00:00Z", sha256: "a".repeat(64), facts: [{ field: "salary_expectation", answer: "AUD 150,000", confirmedAt: "2026-11-04" }] });
class Child extends EventEmitter {
	stdout = new PassThrough(); stderr = new PassThrough(); exitCode: number | null = null;
	kill() { this.exitCode = 143; this.emit("close", 143); return true; }
	answer(draft: unknown) { this.stdout.write(`${JSON.stringify({ type: "result", result: JSON.stringify(draft) })}\n`); this.exitCode = 0; this.emit("close", 0); }
}
let home: string;
let rt: LocalArtifactRuntime;
let calls: Array<{ args: string[]; child: Child }>;
const request = (prefs: unknown = preferences()) => ({
	type: "local_artifact.generate", runId: "run-1", requestId: "request-1", instanceId: "tailor-1", engine: "claude", authMode: "machine", workspace: "~/jobs",
	sources: [{ role: "resume", path: "resume.md" }, { role: "profile", path: "profile.md" }, { role: "answers", path: "answers.md" }],
	lead: { eventId: "event-1", sourceInstanceId: "scout-1", leadId: "lead-1", lifecycleVersion: 1, requestedAt: "2026-11-04T00:00:00Z", lead: { title: "Engineer" } },
	policy: { retainDays: 0, maxMinutes: 10, maxConcurrent: 1 }, instancePreferences: prefs,
});
const draft = (salary: string, source = "instance_preferences", quote = salary) => ({ status: "ready", resume_markdown: "Jane Citizen, software engineer.", cover_letter_markdown: `My salary expectation is ${salary}.`, claims: [{ text: `Salary expectation: ${salary}`, source, quote }] });
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "pags-tailor-prefs-")); mkdirSync(join(home, "jobs"));
	for (const [name, text] of [["resume", "Jane Citizen, software engineer."], ["profile", PROFILE], ["answers", ANSWERS]]) writeFileSync(join(home, "jobs", `${name}.md`), text);
	calls = [];
	rt = new LocalArtifactRuntime({ dataDir: join(home, "data"), homeDir: home, now: () => NOW, spawn: ((_cmd: string, args: string[]) => { const child = new Child(); calls.push({ args, child }); return child; }) as never });
});
afterEach(() => { rt.closeAll(); rmSync(home, { recursive: true, force: true }); });

it("uses fresh facts for drafting but exports and hashes original source bytes", async () => {
	rt.start(request()); await settle();
	const prompt = calls[0].args[1];
	expect(prompt).toContain('<source role="instance_preferences">');
	expect(prompt).toContain("AUD 150,000"); expect(prompt).not.toContain("AUD 180,000");
	expect(readFileSync(join(home, "jobs/profile.md"), "utf8")).toBe(PROFILE);
	writeFileSync(join(home, "jobs/profile.md"), "changed after launch");
	calls[0].child.answer(draft("AUD 150,000")); await settle();
	const status = rt.status({ runId: "run-1" });
	expect(status.result?.outcome).toBe("completed");
	expect(status.result?.sourceHashes.find(x => x.role === "profile")).toMatchObject({ sha256: hash(PROFILE), bytes: Buffer.byteLength(PROFILE) });
	const documents = rt.documents({ runId: "run-1" }, "tailor-1").documents;
	for (const [role, original] of [["profile", PROFILE], ["answers", ANSWERS]]) {
		const doc = documents.find(x => x.role === role)!;
		expect(Buffer.from(doc.contentBase64, "base64").toString()).toBe(original); expect(doc.sha256).toBe(hash(original));
	}
	const manifest = JSON.parse(readFileSync(join(home, "jobs/applications/lead-1/run-1", ARTIFACT_MANIFEST), "utf8"));
	expect(manifest.sources).toEqual(status.result?.sourceHashes);
	expect(status.events.find(x => x.detail?.role === "instance_preferences")?.detail).toEqual({ role: "instance_preferences", path: "instance/tailor-1/job_application_preferences@2026-11-04T00:00:00Z", sha256: preferences().sha256, count: 1 });
	expect(JSON.stringify(status.events)).not.toContain("150,000");
});

it("rejects stale salary even with an otherwise valid fresh-source citation and bounds repair", async () => {
	rt.start(request()); await settle();
	const stale = draft("AUD 180,000", "resume", "Jane Citizen");
	calls[0].child.answer(stale); await settle();
	expect(calls).toHaveLength(2);
	calls[1].child.answer(stale); await settle();
	expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "needs_human", artifacts: [] });
	expect(calls).toHaveLength(2); expect(existsSync(join(home, "jobs/applications/lead-1/run-1/resume.md"))).toBe(false);
});

it.each([
	["wrong instance", { ...preferences(), instanceId: "other" }],
	["malformed receipt", { ...preferences(), sha256: "invalid" }],
	["expired fact", { ...preferences(), facts: [{ ...preferences().facts[0], validUntil: "2026-11-03", confirmedAt: "2026-11-01" }] }],
])("refuses %s before spawning", (_why, value) => {
	expect(() => rt.start(request(value))).toThrow(); expect(calls).toHaveLength(0);
});

it("keeps legacy source behavior when preferences are absent", async () => {
	rt.start({ ...request(), instancePreferences: undefined }); await settle();
	expect(calls[0].args[1]).toContain("AUD 180,000");
	calls[0].child.answer(draft("AUD 180,000", "profile", "Salary expectation: AUD 180,000.")); await settle();
	expect(rt.status({ runId: "run-1" }).result?.outcome).toBe("completed");
});


it("supersedes historical account-wide answers without removing unrelated answers", async () => {
	rt.start({ ...request(), ownerAnswers: [{ question: "What is your salary expectation?", answer: "AUD 180,000" }, { question: "Which city do you live in?", answer: "Sydney" }] }); await settle();
	const prompt = calls[0].args[1];
	expect(prompt).not.toContain("AUD 180,000"); expect(prompt).toContain("Which city do you live in?");
	calls[0].child.answer(draft("AUD 150,000")); await settle();
	expect(rt.status({ runId: "run-1" }).result?.outcome).toBe("completed");
});

it("checks recognized salary text even when claims only cite unrelated valid facts", async () => {
	rt.start(request()); await settle();
	const stale = { ...draft("AUD 180,000"), claims: [{ text: "Jane Citizen", source: "resume", quote: "Jane Citizen" }] };
	calls[0].child.answer(stale); await settle(); calls[1].child.answer(stale); await settle();
	expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "needs_human", artifacts: [] });
});

it("does not infer salary super basis from the base salary fact", async () => {
	rt.start({ ...request(), instancePreferences: { ...preferences(), pendingFields: ["salary_super_basis"] } }); await settle();
	const unsupported = { ...draft("AUD 150,000"), cover_letter_markdown: "My salary expectation is AUD 150,000 including super." };
	calls[0].child.answer(unsupported); await settle(); calls[1].child.answer(unsupported); await settle();
	expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "needs_human", artifacts: [] });
});


it("does not validate a salary range just because one end quotes the current amount", async () => {
	rt.start(request()); await settle();
	const unsupported = draft("AUD 150,000 to AUD 180,000", "instance_preferences", "AUD 150,000");
	calls[0].child.answer(unsupported); await settle(); calls[1].child.answer(unsupported); await settle();
	expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "needs_human", artifacts: [] });
});


it.each(["AUD 180,000, not AUD 150,000", "not AUD 150,000"])("rejects contradicted current salary wording: %s", async (value) => {
	rt.start(request()); await settle();
	const unsupported = draft(value, "instance_preferences", "AUD 150,000");
	calls[0].child.answer(unsupported); await settle(); calls[1].child.answer(unsupported); await settle();
	expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "needs_human", artifacts: [] });
});


it.each(["completed", "needs_human", "cancelled"])("releases the private preferences after %s while retaining the provenance receipt", async (outcome) => {
	rt.start(request()); await settle();
	const retained = Reflect.get(rt, "runs") as ReadonlyMap<string, { envelope: { instancePreferences?: InstancePreferences } }>;
	expect(retained.get("run-1")?.envelope.instancePreferences?.facts).toHaveLength(1);
	if (outcome === "cancelled") rt.cancel({ runId: "run-1" });
	else calls[0].child.answer(outcome === "completed" ? draft("AUD 150,000") : { status: "needs_human", questions: ["Confirm the job details."] });
	await settle();
	expect(rt.status({ runId: "run-1" }).state).toBe("ended");
	expect(retained.get("run-1")?.envelope.instancePreferences).toBeUndefined();
	expect(rt.status({ runId: "run-1" }).events.some(event => event.type === "source.read" && event.detail?.role === "instance_preferences")).toBe(true);
	if (outcome === "completed") expect(rt.documents({ runId: "run-1" }, "tailor-1").documents.some(doc => doc.role === "profile")).toBe(true);
});
