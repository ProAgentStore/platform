/** #1148 — the parent side: run the candidate's entry as `runner probe` and read its verdict, with a real child process too. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_PROBE_ENV, PROBE_ENV, probePayload } from "./start-probe.js";

const marker = (r: unknown) => `ok   loads: x\nPAGS_PROBE ${JSON.stringify(r)}\n`;
const run = (over: Partial<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }>) => async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...over });
const step = (name: string, ok: boolean, detail = "d") => ({ name, ok, detail });

describe("probePayload — reading the verdict", () => {
	it("runs `node <entry> runner probe --expect <version>` with PAGS_PROBE=1 so it cannot probe again", async () => {
		let seen: { file: string; args: string[]; env: NodeJS.ProcessEnv } | null = null;
		await probePayload("/cache/0.4.150/x/dist/index.js", "0.4.150", { node: "/usr/bin/node", env: { PATH: "/bin" }, run: async (file, args, env) => { seen = { file, args, env }; return { code: 0, signal: null, stdout: marker({ ok: true, steps: [] }), stderr: "", timedOut: false }; } });
		expect(seen).toMatchObject({ file: "/usr/bin/node", args: ["/cache/0.4.150/x/dist/index.js", "runner", "probe", "--expect", "0.4.150"] });
		expect((seen as unknown as { env: NodeJS.ProcessEnv }).env[PROBE_ENV]).toBe("1");
	});
	it("passed", async () => {
		const v = await probePayload("e", "1", { env: {}, run: run({ stdout: marker({ ok: true, steps: [step("loads", true, "1 started"), step("relay", true, "answered")] }) }) });
		expect(v).toEqual({ state: "passed", detail: "loads: 1 started; relay: answered" });
	});
	it("a failed load is permanent; a failed session or relay is not", async () => {
		expect(await probePayload("e", "1", { env: {}, run: run({ code: 1, stdout: marker({ ok: false, steps: [step("loads", false, "not the release")] }) }) })).toMatchObject({ state: "failed", permanent: true, detail: "loads: not the release" });
		expect(await probePayload("e", "1", { env: {}, run: run({ code: 1, stdout: marker({ ok: false, steps: [step("loads", true), step("session", false, "401"), step("relay", false, "not tried")] }) }) })).toMatchObject({ state: "failed", permanent: false, detail: "session: 401; relay: not tried" });
	});
	it("no verdict line: the candidate did not start (its own words), permanent", async () => {
		const v = await probePayload("e", "1", { env: {}, run: run({ code: 1, stderr: "node:internal/modules\nSyntaxError: Unexpected token\n" }) });
		expect(v).toEqual({ state: "failed", permanent: true, detail: "it did not start: SyntaxError: Unexpected token" });
		expect(await probePayload("e", "1", { env: {}, run: run({ code: null, signal: "SIGSEGV" }) })).toMatchObject({ state: "failed", detail: "it did not start: killed by SIGSEGV" });
	});
	it("an unreadable verdict fails; a timeout and a spawn failure fail without calling the release broken", async () => {
		expect(await probePayload("e", "1", { env: {}, run: run({ stdout: "PAGS_PROBE {not json" }) })).toMatchObject({ state: "failed", permanent: true });
		expect(await probePayload("e", "1", { env: {}, timeoutMs: 5_000, run: run({ timedOut: true }) })).toMatchObject({ state: "failed", permanent: false, detail: expect.stringMatching(/within 5s/) });
		expect(await probePayload("e", "1", { env: {}, run: async () => { throw new Error("EACCES"); } })).toMatchObject({ state: "failed", permanent: false, detail: "could not start it: EACCES" });
	});
	it("a release that predates the probe is not failed for it", async () => {
		expect(await probePayload("e", "1", { env: {}, run: run({ code: 1, stderr: "error: unknown command 'probe'" }) })).toMatchObject({ state: "skipped" });
	});
	it("can be switched off, and never recurses", async () => {
		const never = async () => { throw new Error("must not run"); };
		expect(await probePayload("e", "1", { env: { [NO_PROBE_ENV]: "1" }, run: never })).toMatchObject({ state: "skipped" });
		expect(await probePayload("e", "1", { env: { [PROBE_ENV]: "1" }, run: never })).toMatchObject({ state: "skipped" });
	});
});

describe("probePayload — against a real child process", () => {
	let dir: string;
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pags-probe-")); });
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const entry = (src: string) => { const p = join(dir, "index.js"); writeFileSync(p, src); return p; };

	it("a payload that prints a passing verdict passes; one that throws on load fails with its error", async () => {
		const ok = entry(`console.log("PAGS_PROBE " + JSON.stringify({ ok: true, version: "9.9.9", steps: [{ name: "loads", ok: true, detail: process.argv.slice(2).join(" ") }] }));`);
		expect(await probePayload(ok, "9.9.9", { env: process.env })).toEqual({ state: "passed", detail: "loads: runner probe --expect 9.9.9" });
		const bad = entry(`throw new Error("boom on load");`);
		expect(await probePayload(bad, "9.9.9", { env: process.env })).toMatchObject({ state: "failed", permanent: true, detail: expect.stringContaining("boom on load") });
	});
	it("a payload that hangs is killed at the deadline", async () => {
		const hang = entry(`setInterval(() => {}, 1000);`);
		const v = await probePayload(hang, "9.9.9", { env: process.env, timeoutMs: 300 });
		expect(v).toMatchObject({ state: "failed", permanent: false });
	});
});
