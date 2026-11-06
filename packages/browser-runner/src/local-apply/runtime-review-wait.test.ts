/** Invariant: owner review retains one run/page/engine; only its exact scoped grant releases it. */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import type { LocalApplyTaskEnvelope } from "./contract.js";
import { LocalApplyRuntime } from "./runtime.js";

class Child extends EventEmitter {
	stdout = new PassThrough(); stderr = new PassThrough(); exitCode: number | null = null;
	kill() { this.exit(143); return true; }
	exit(code: number) { if (this.exitCode !== null) return; this.exitCode = code; this.emit("close", code); }
}
const fixtures: Array<ReturnType<typeof fixture>> = [];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const RESUME = "# Jane Citizen\nEngineer, Sample Systems, 2020 to 2024.\n";
const COVER = "Dear synthetic hiring team, I would like to apply.\n";
const turn = () => new Promise((resolve) => setTimeout(resolve, 20));

function fixture(confirmSubmission = false) {
	const dir = mkdtempSync(join(tmpdir(), "pags-review-wait-")); const home = join(dir, "home");
	mkdirSync(join(home, "jobs/applications/lead/materials"), { recursive: true });
	writeFileSync(join(home, "jobs/profile.md"), "Full name: Jane Citizen\nEmail: jane@example.com\n");
	writeFileSync(join(home, "jobs/applications/lead/materials/resume.md"), RESUME);
	writeFileSync(join(home, "jobs/applications/lead/materials/cover-letter.md"), COVER);
	let now = 1000; let url = "https://forms.example.test/apply"; let closed = false; let confirmed = false;
	let page = { isClosed: () => closed, url: () => url } as Page;
	const child = new Child(); const stop = vi.fn(async () => {}); const spawn = vi.fn(() => child);
	const callTool = vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
		if (name === "browser_snapshot") return { content: [{ text: '- textbox "Name" [ref=n1]\n- button "Submit application" [ref=s1]' }] };
		if (name === "browser_evaluate") return { content: [{ text: `### Result\n${JSON.stringify(args.target ? { submits: true, method: "post", name: "Submit application", tag: "button", type: "submit" } : { url, title: "Synthetic application", confirmed })}` }] };
		if (name === "browser_click" && confirmSubmission) { confirmed = true; url = "https://forms.example.test/thanks"; }
		return { content: [{ text: `${name} completed` }] };
	});
	const browser: BrowserTools = {
		configureToolAccess: async () => {}, setCallPolicy: () => {},
		listTools: async () => ["browser_snapshot", "browser_type", "browser_click", "browser_evaluate"].map((name) => ({ name, inputSchema: {} })), callTool,
	};
	const browserFor = vi.fn(async () => ({ tools: browser, stop, handoffPage: () => page }));
	const rt = new LocalApplyRuntime({ dataDir: join(dir, "data"), homeDir: home, selfUrl: () => "http://127.0.0.1:4999", bridgeScript: "/test/bridge.js", renderPdf: async (source) => Buffer.from(`%PDF-1.7\n${source}\n%%EOF`), spawn: spawn as never, browserFor, now: () => now });
	const envelope: LocalApplyTaskEnvelope = {
		type: "local_browser.apply", runId: "review-run", requestId: "review-request", instanceId: "review-instance", applicationId: "review-application", engine: "codex", authMode: "machine", browserProfile: "isolated", applicationUrl: url, job: { title: "Engineer", company: "Synthetic employer" }, workspace: "~/jobs", sources: [{ role: "profile", path: "profile.md" }],
		artifacts: [{ kind: "resume", path: "~/jobs/applications/lead/materials/resume.md", sha256: sha(RESUME) }, { kind: "cover_letter", path: "~/jobs/applications/lead/materials/cover-letter.md", sha256: sha(COVER) }],
		policy: { mode: "fill_and_review", toolAccess: "full", toolAccessAcceptance: { revision: "full_playwright_v1", acceptedAt: "2026-11-06T00:00:00Z", acceptedBy: "synthetic-owner", instanceId: "review-instance" }, escalationLevel: "autonomous", allowDomains: ["forms.example.test"] }, limits: { maxMinutes: 20, maxPages: 10, maxActions: 100 },
	};
	const status = () => rt.status({ runId: envelope.runId });
	const call = (name: string, args: Record<string, unknown> = {}) => rt.bridge({ runId: envelope.runId, op: "call", name, args }) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
	const approval = (checkpointId: string) => ({ runId: envelope.runId, schemaVersion: 1, checkpointId, directive: "continue", submitAuthorization: { id: "owner-grant", gateId: "submit-gate", instanceId: envelope.instanceId, applicationId: envelope.applicationId, artifacts: envelope.artifacts.map(({ kind, sha256 }) => ({ kind, sha256 })) } });
	const f = { dir, rt, envelope, status, call, approval, child, stop, spawn, browserFor, callTool, advance: (ms: number) => { now += ms; }, navigate: () => { url += "?changed=1"; }, replacePage: () => { page = { isClosed: () => closed, url: () => url } as Page; }, closePage: () => { closed = true; } };
	fixtures.push(f); rt.start(envelope); return f;
}
afterEach(() => { for (const f of fixtures.splice(0)) { f.rt.closeAll(); rmSync(f.dir, { recursive: true, force: true }); } });

async function review(f: ReturnType<typeof fixture>) {
	await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
	await f.call("browser_snapshot"); await f.call("browser_type", { target: "n1", text: "Jane Citizen" }); await f.call("browser_snapshot");
	const pending = f.call("ready_for_review", { summary: "Synthetic form values verified; owner decision required." });
	await vi.waitFor(() => expect(f.status().state).toBe("paused"));
	return { pending, checkpoint: f.status().pause!.checkpoint! };
}

describe("same-run Full review approval", () => {
	it("retains one engine and page, rejects plain resume/continue, and accepts only the scoped grant", async () => {
		const f = fixture(); const { pending, checkpoint } = await review(f);
		expect(checkpoint.facts).toMatchObject({ phase: "before_submit", reviewWait: { budgetMs: 1_080_000 } });
		expect(f.child.exitCode).toBeNull(); expect(f.stop).not.toHaveBeenCalled();
		expect(() => f.rt.resume({ runId: f.envelope.runId })).toThrow();
		expect(() => f.rt.directive({ runId: f.envelope.runId, schemaVersion: 1, checkpointId: checkpoint.checkpointId, directive: "continue" })).toThrow();
		expect(f.status().state).toBe("paused");
		const grant = f.approval(checkpoint.checkpointId); f.rt.directive(grant);
		const response = await pending;
		expect(response.isError).not.toBe(true); expect(JSON.stringify(response)).toMatch(/snapshot|observe/i);
		expect(f.status().state).toBe("running"); expect(f.spawn).toHaveBeenCalledOnce(); expect(f.browserFor).toHaveBeenCalledOnce(); expect(f.stop).not.toHaveBeenCalled();
		expect(() => f.rt.directive(grant)).not.toThrow();
		expect(f.callTool.mock.calls.filter(([name]) => name === "browser_click")).toHaveLength(0);
		f.child.exit(0); expect(f.status().result?.submissionVerification).toBe("unverified");
	});
	it.each([true, false])("requires a post-approval snapshot and reports the actual supervised outcome (confirmed=%s)", async (confirmed) => {
		const f = fixture(confirmed); const { pending, checkpoint } = await review(f);
		f.rt.directive(f.approval(checkpoint.checkpointId)); await pending;
		const approveCheckpoint = async (checkpointId: string) => {
			const waiting = f.call("supervisor_checkpoint", { checkpointId, phase: "before_submit" });
			await vi.waitFor(() => expect(f.status().pause?.checkpoint?.checkpointId).toBe(checkpointId));
			f.rt.directive({ runId: f.envelope.runId, schemaVersion: 1, checkpointId, directive: "continue" });
			expect((await waiting).isError).not.toBe(true);
		};
		await approveCheckpoint("stale-observation");
		const stale = await f.call("submit_application", { ref: "s1" });
		expect(stale.isError).toBe(true); expect(JSON.stringify(stale)).toMatch(/current snapshot/);
		expect(f.callTool.mock.calls.filter(([name]) => name === "browser_click")).toHaveLength(0);
		expect(f.status().events.some((event) => event.type === "submit.attempted")).toBe(false);
		await f.call("browser_snapshot"); await approveCheckpoint("fresh-observation");
		const submitted = await f.call("submit_application", { ref: "s1" });
		expect(Boolean(submitted.isError)).toBe(!confirmed);
		expect(f.callTool.mock.calls.filter(([name]) => name === "browser_click")).toHaveLength(1);
		f.child.exit(0); const result = f.status().result!;
		expect(result.submitAttempted).toBe(true);
		expect(result.summary).not.toContain("Synthetic form values verified; owner decision required.");
		if (confirmed) {
			expect(result).toMatchObject({ outcome: "submitted", submitted: { gateId: "submit-gate", url: "https://forms.example.test/thanks" } });
			expect(result.summary).toMatch(/confirmed.*supervised submission/);
			expect(result.summary).toMatch(/Other actions.*unverified/);
		} else {
			expect(result).toMatchObject({ blockReason: "submit_unconfirmed", submissionVerification: "unverified" });
			expect(result.summary).toMatch(/submit was pressed.*did not confirm/);
		}
	});
	it.each(["application", "instance", "resume", "checkpoint"] as const)("rejects a grant for another %s without spending the wait", async (mismatch) => {
		const f = fixture(); const { pending, checkpoint } = await review(f); const grant = f.approval(checkpoint.checkpointId);
		if (mismatch === "application") grant.submitAuthorization.applicationId = "different-app";
		if (mismatch === "instance") grant.submitAuthorization.instanceId = "different-instance";
		if (mismatch === "resume") grant.submitAuthorization.artifacts[0]!.sha256 = "f".repeat(64);
		if (mismatch === "checkpoint") grant.checkpointId = "different-checkpoint";
		expect(() => f.rt.directive(grant)).toThrow(); expect(f.status().state).toBe("paused");
		f.rt.cancel({ runId: f.envelope.runId }); expect((await pending).isError).toBe(true);
	});
	it.each(["navigate", "replacePage", "closePage"] as const)("does not approve a lost review page: %s", async (change) => {
		const f = fixture(); const { pending, checkpoint } = await review(f); f[change]();
		expect(() => f.rt.directive(f.approval(checkpoint.checkpointId))).toThrow();
		f.rt.cancel({ runId: f.envelope.runId }); expect((await pending).isError).toBe(true);
		expect(f.callTool.mock.calls.filter(([name]) => name === "browser_click")).toHaveLength(0);
	});
	it.each(["source", "rendered PDF", "native PDF"] as const)("rechecks the actual %s bytes before accepting approval", async (changed) => {
		const f = fixture(); const { pending, checkpoint } = await review(f);
		const runDir = join(f.dir, "data/local-apply/review-instance/review-run");
		const path = changed === "source" ? join(f.dir, "home/jobs/applications/lead/materials/resume.md") : join(runDir, changed === "native PDF" ? "native-documents/resume.pdf" : "documents/resume.pdf");
		writeFileSync(path, "Changed after review");
		expect(() => f.rt.directive(f.approval(checkpoint.checkpointId))).toThrow(/changed|identities/);
		expect(f.status().state).toBe("paused");
		f.rt.cancel({ runId: f.envelope.runId }); expect((await pending).isError).toBe(true);
		expect(f.callTool.mock.calls.filter(([name]) => name === "browser_click")).toHaveLength(0);
	});
	it("rejects changed authority on duplicate delivery without issuing a second permission", async () => {
		const f = fixture(); const { pending, checkpoint } = await review(f); const grant = f.approval(checkpoint.checkpointId);
		f.rt.directive(grant); await pending;
		for (const field of ["id", "gateId", "applicationId", "instanceId"] as const) {
			const changed = structuredClone(grant); changed.submitAuthorization[field] = "different";
			expect(() => f.rt.directive(changed)).toThrow(/different authorization/);
		}
		expect(f.spawn).toHaveBeenCalledOnce(); expect(f.browserFor).toHaveBeenCalledOnce();
		expect(f.callTool.mock.calls.filter(([name]) => name === "browser_click")).toHaveLength(0);
	});
	it("expires once without recreating a browser or accepting late approval", async () => {
		const f = fixture(); const { pending, checkpoint } = await review(f); f.advance(1_080_001);
		expect(f.status().state).toBe("ended"); expect((await pending).isError).toBe(true);
		expect(() => f.rt.directive(f.approval(checkpoint.checkpointId))).toThrow();
		expect(f.spawn).toHaveBeenCalledOnce(); expect(f.browserFor).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalledOnce();
		expect(f.status().result).toMatchObject({ submitAttempted: false, submissionVerification: "unverified" });
	});
	it("Stop releases the held call and keeps later browser dispatch refused", async () => {
		const f = fixture(); const { pending } = await review(f); const before = f.callTool.mock.calls.length;
		f.rt.cancel({ runId: f.envelope.runId }); expect((await pending).isError).toBe(true);
		await turn(); await expect(f.call("browser_click", { target: "s1" })).rejects.toThrow(/not active/);
		expect(f.callTool).toHaveBeenCalledTimes(before); expect(f.status().result?.submissionVerification).toBe("unverified");
	});
});
