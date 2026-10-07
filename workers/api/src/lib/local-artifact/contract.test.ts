/**
 * The PAGS ↔ runner contract for local artifact generation (#956): the two vendored copies are one
 * file, a malformed lead is named, and a runner cannot put content into a trace or a result.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isHomeRelative, isWorkspaceRelative, parseLocalArtifactEvent, parseLocalArtifactLead, parseLocalArtifactResult } from "./contract";

const ROOT = join(__dirname, "../../../../..");

describe("the vendored copy", () => {
	it("is byte-identical in the Worker and the runner — edit both together", () => {
		const worker = readFileSync(join(ROOT, "workers/api/src/lib/local-artifact/contract.ts"), "utf8");
		expect(readFileSync(join(ROOT, "packages/browser-runner/src/local-artifact/contract.ts"), "utf8")).toBe(worker);
		expect(worker).not.toMatch(/^import /m);
	});
});

const LEAD = { eventId: "s:l:1", sourceInstanceId: "s", leadId: "lead-1", leadUrl: "https://jobs.example.com/1", lifecycleVersion: 1, requestedAt: "2026-10-07T00:00:00Z", lead: { title: "Engineer", company: "Globex", email: "x@y.z" } };

describe("parseLocalArtifactLead", () => {
	it("keeps the whitelisted lead fields only", () => {
		const r = parseLocalArtifactLead(LEAD);
		expect("lead" in r && r.lead.lead).toEqual({ title: "Engineer", company: "Globex" });
	});
	it.each([
		["no title", { ...LEAD, lead: {} }, /job title/],
		["a leadId that is not a folder name", { ...LEAD, leadId: "../x" }, /leadId/],
		["no lifecycle version", { ...LEAD, lifecycleVersion: 0 }, /lifecycleVersion/],
		["a non-http URL", { ...LEAD, leadUrl: "javascript:alert(1)" }, /http/],
	])("names %s", (_, raw, msg) => {
		const r = parseLocalArtifactLead(raw);
		expect("error" in r && r.error).toMatch(msg);
	});
});

describe("paths", () => {
	it.each(["resume.md", "cv/master.md"])("accepts %s inside the workspace", (p) => expect(isWorkspaceRelative(p)).toBe(true));
	it.each(["../x", "/etc/passwd", "a/../../b", "~/x", "a\\b", "", "a//b", "./a"])("refuses %s", (p) => expect(isWorkspaceRelative(p)).toBe(false));
	it("requires ~/ for a workspace", () => {
		expect(isHomeRelative("~/jobs")).toBe(true);
		expect(isHomeRelative("/jobs")).toBe(false);
		expect(isHomeRelative("~/../etc")).toBe(false);
	});
});

describe("what a runner may report", () => {
	it("keeps only handle-shaped trace detail", () => {
		expect(parseLocalArtifactEvent({ type: "source.read", at: "2026-10-07T00:00:00Z", detail: { role: "resume", sha256: "a".repeat(64), bytes: 10, text: "Jane Citizen", nested: { x: 1 } } })).toEqual({
			type: "source.read",
			at: "2026-10-07T00:00:00Z",
			detail: { role: "resume", sha256: "a".repeat(64), bytes: 10 },
		});
		expect(parseLocalArtifactEvent({ type: "run.ended", at: "2026-10-07T00:00:00Z" })).toBeNull(); // a platform event
	});

	const base = { runId: "r", traceId: "r", engineAuth: "machine-login", sourceHashes: [], profileVersion: null };
	it("refuses an artifact outside ~/ or without a hash", () => {
		expect(parseLocalArtifactResult({ ...base, outcome: "completed", artifacts: [{ kind: "resume", path: "/tmp/r.md", sha256: "a".repeat(64), bytes: 1 }] })).toHaveProperty("error");
		expect(parseLocalArtifactResult({ ...base, outcome: "completed", artifacts: [{ kind: "resume", path: "~/r.md", sha256: "nope", bytes: 1 }] })).toHaveProperty("error");
	});
	it("defaults an unknown block reason and bounds the questions", () => {
		const r = parseLocalArtifactResult({ ...base, outcome: "needs_human", artifacts: [], blockReason: "made_up", questions: Array.from({ length: 50 }, (_, i) => `q${i}`) });
		expect("result" in r && r.result).toMatchObject({ blockReason: "missing_information" });
		expect("result" in r && r.result.questions).toHaveLength(20);
	});
	it("has no api-key engine mode to report as a choice, but reports one if observed", () => {
		expect(parseLocalArtifactResult({ ...base, engineAuth: "api-key", outcome: "needs_human", artifacts: [], blockReason: "api_key_refused" })).toMatchObject({ result: { engineAuth: "api-key", blockReason: "api_key_refused" } });
	});
});
