import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPLY_START_UNCERTAIN, claimApplyStart, rememberApplyStart } from "./start-claim.js";

let temp: string;
let claims: string;
let runDir: string;
const identity = { instanceId: "instance", runId: "run", requestId: "request" };
beforeEach(() => { temp = mkdtempSync(join(tmpdir(), "pags-start-claim-")); claims = join(temp, "claims"); runDir = join(temp, "runs", "run"); });
afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe("a local application start is never replayable after interruption (#1444)", () => {
	it("claims the request and run before execution, and a fresh caller cannot claim either again", () => {
		claimApplyStart(claims, runDir, identity);
		expect(() => claimApplyStart(claims, runDir, identity)).toThrow(expect.objectContaining({ code: APPLY_START_UNCERTAIN }));
		expect(() => claimApplyStart(claims, join(temp, "other-run"), { ...identity, runId: "other-run" })).toThrow(expect.objectContaining({ code: APPLY_START_UNCERTAIN }));
		expect(() => claimApplyStart(claims, runDir, { ...identity, requestId: "other-request" })).toThrow(expect.objectContaining({ code: APPLY_START_UNCERTAIN }));
	});

	it("treats a pre-upgrade interrupted run directory as uncertain, even without a claim file", () => {
		mkdirSync(runDir, { recursive: true });
		expect(() => claimApplyStart(claims, runDir, identity)).toThrow(expect.objectContaining({ code: APPLY_START_UNCERTAIN }));
		rmSync(runDir, { recursive: true });
		expect(() => claimApplyStart(claims, runDir, identity)).toThrow(expect.objectContaining({ code: APPLY_START_UNCERTAIN }));
	});

	it("retention may remove scratch files without allowing a second execution", () => {
		rememberApplyStart(claims, runDir, identity);
		rememberApplyStart(claims, runDir, identity);
		expect(() => claimApplyStart(claims, runDir, identity)).toThrow(expect.objectContaining({ code: APPLY_START_UNCERTAIN }));
		expect(() => claimApplyStart(claims, join(temp, "new-run"), { ...identity, runId: "new-run" })).toThrow(expect.objectContaining({ code: APPLY_START_UNCERTAIN }));
	});

	it("stores only id metadata and keeps unrelated requests independent", () => {
		claimApplyStart(claims, runDir, identity);
		claimApplyStart(claims, join(temp, "runs", "next"), { ...identity, runId: "next", requestId: "next" });
		for (const file of readdirSync(claims)) {
			const value = JSON.parse(readFileSync(join(claims, file), "utf8"));
			expect(Object.keys(value).every((key) => key === "version" || key === "runId")).toBe(true);
		}
	});
});
