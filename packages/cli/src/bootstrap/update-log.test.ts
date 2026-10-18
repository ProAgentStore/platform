import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logUpdateStep, updateLogPath, updateLogTail, updateLogUpload } from "./update-log.js";

describe("the step-by-step update log (#1151)", () => {
	let dir: string;
	let env: NodeJS.ProcessEnv;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-update-log-"));
		env = { PAGS_CONFIG_DIR: dir };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("lives in the config dir and records one timestamped, pid-stamped line per step", () => {
		expect(updateLogPath(env)).toBe(join(dir, "update.log"));
		logUpdateStep("install: 0.4.149 → 0.4.150 starting", env, new Date("2026-10-18T01:39:50.000Z"));
		logUpdateStep("install: 0.4.150 FAILED — npm ERR! code E404\nnpm ERR! 404 Not Found", env, new Date("2026-10-18T01:40:01.000Z"));
		expect(readFileSync(updateLogPath(env), "utf8")).toBe(
			`2026-10-18T01:39:50.000Z [${process.pid}] install: 0.4.149 → 0.4.150 starting\n` +
				`2026-10-18T01:40:01.000Z [${process.pid}] install: 0.4.150 FAILED — npm ERR! code E404 | npm ERR! 404 Not Found\n`,
		);
	});

	it("never throws, even when the log cannot be written", () => {
		writeFileSync(join(dir, "blocker"), "a file where a directory must go");
		expect(() => logUpdateStep("x", { PAGS_UPDATE_LOG: join(dir, "blocker", "update.log") })).not.toThrow();
	});

	it("uploads only the newest whole lines, bounded — and nothing when there is no log", () => {
		expect(updateLogTail(env)).toBeNull();
		for (let i = 0; i < 200; i++) logUpdateStep(`step ${i}`, env);
		const tail = updateLogTail(env, 500) ?? "";
		expect(tail.length).toBeLessThanOrEqual(500);
		expect(tail.split("\n")[0]).toMatch(/^\d{4}-\d\d-\d\dT.* step \d+$/);
		expect(tail.endsWith("step 199")).toBe(true);
	});

	it("cuts itself back to its newest half past 256KB, so it never grows without bound", () => {
		writeFileSync(updateLogPath(env), `${"old line\n".repeat(40_000)}`);
		logUpdateStep("newest", env);
		const text = readFileSync(updateLogPath(env), "utf8");
		expect(text.length).toBeLessThan(200_000);
		expect(text.trimEnd().endsWith("newest")).toBe(true);
		expect(text.startsWith("old line\n")).toBe(true); // cut on a line boundary
	});

	it("rides a start's reports until the platform first answers, then stops — once per start, with the answer logged", () => {
		logUpdateStep("restart: leaving for the pags-up restarter (exit 75)", env);
		const upload = updateLogUpload("0.4.150", env);
		expect(upload.body().updateLog).toMatch(/leaving for the pags-up restarter/);
		expect(upload.body().updateLog).toBe(upload.body().updateLog); // every report of this start, until answered
		upload.answered();
		upload.answered();
		expect(upload.body()).toEqual({});
		expect(readFileSync(updateLogPath(env), "utf8").match(/registered: 0\.4\.150 answered by the platform/g)).toHaveLength(1);
		expect(updateLogUpload("0.4.150", { PAGS_CONFIG_DIR: join(dir, "empty") }).body()).toEqual({});
	});

	it("what it uploads goes through the shared redactor — a session token a step quoted never reaches the platform (#1166)", () => {
		const session = `${Buffer.from(JSON.stringify({ uid: "github:serge-ivo", exp: 2 })).toString("base64url")}.${"s".repeat(43)}`;
		logUpdateStep(`restart: pags up --pags-token ${session} --headless`, env);
		logUpdateStep("install: npm i -g @proagentstore/cli@0.4.158 token=npm_abcdefgh12345678", env);
		const tail = updateLogTail(env) ?? "";
		expect(tail).not.toContain(session);
		expect(tail).not.toContain("npm_abcdefgh12345678");
		expect(tail).toContain("[redacted-jwt]");
		expect(updateLogUpload("0.4.158", env).body().updateLog).toBe(tail);
	});
});
