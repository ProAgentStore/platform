/**
 * The runner's pane says what it no longer holds (#898). The transcript kept its newest 3,000
 * records with no trace of the rest, an oversized stream-json line was discarded whole, and the
 * 64 KiB capture cut its head silently — so the Pilot's "last 6,000 of N" understated N.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HeadlessSession } from "./headless.js";
import { CodingRuntime } from "./runtime.js";

const session = (clientType: "claude" | "codex") => {
	const dir = mkdtempSync(join(tmpdir(), "pags-pane-"));
	return new HeadlessSession({ id: `pane-${clientType}`, workDir: dir, clientType, statePath: join(dir, "state.json") });
};
type Internals = { pushRaw(line: string): void; buf: string; mode: string; push(line: string): void };

describe("the transcript counts the records it trims", () => {
	it("prefixes the pane with how many earlier lines are gone", () => {
		const s = session("codex");
		for (let i = 0; i < 4001; i++) (s as unknown as Internals).pushRaw(`line ${i}`);
		const pane = s.snapshot();
		expect(pane.startsWith("[1001 earlier lines of this session's output are no longer kept]\n")).toBe(true);
		expect(pane.endsWith("line 4000")).toBe(true);
	});

	it("adds nothing while nothing has been trimmed", () => {
		const s = session("codex");
		(s as unknown as Internals).pushRaw("only line");
		expect(s.snapshot()).toBe("only line");
	});
});

describe("the capture reports the pane's true length and marks the 64 KiB cut", () => {
	it("returns paneChars and a [cut: …] header", () => {
		const rt = new CodingRuntime(mkdtempSync(join(tmpdir(), "pags-rt-")));
		const s = session("codex");
		for (let i = 0; i < 3000; i++) (s as unknown as Internals).pushRaw(`${"x".repeat(40)} ${i}`);
		(rt as unknown as { sessions: Map<string, HeadlessSession> }).sessions.set("sid", s);
		const snap = rt.snapshot("sid");
		const full = s.snapshot().length;
		expect(snap.paneChars).toBe(full);
		expect(snap.pane.startsWith(`[cut: showing the last ${64 * 1024} of ${full} characters]\n`)).toBe(true);
		expect(snap.pane.endsWith(" 2999")).toBe(true);
	});
});
