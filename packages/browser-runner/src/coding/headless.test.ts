import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultStatePath, HeadlessSession } from "./headless.js";

/**
 * A stand-in for `claude -p --input-format stream-json --output-format stream-json`:
 * emits an init event, then for each user turn on stdin replies with an assistant
 * text block + a result event (the turn boundary the engine keys "idle" off).
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc-123" }) + "\\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "user") return;
  const text = (msg.message?.content || []).map((b) => b.text).join(" ");
  // A tool use + result, then the assistant's reply, then the turn result.
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git pull" } }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "Already up to date." }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done: " + text }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done: " + text }) + "\\n");
});
`;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 4000): Promise<void> {
	const start = Date.now();
	while (!cond() && Date.now() - start < timeoutMs) await wait(25);
}

describe("HeadlessSession (stream-json engine)", () => {
	let dir: string;
	let bin: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-headless-"));
		bin = join(dir, "fake-claude.js");
		writeFileSync(bin, FAKE_CLAUDE);
		chmodSync(bin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("drives a turn via stdin/stdout JSON: thinking → real reply → idle", async () => {
		const statePath = defaultStatePath(dir);
		const s = new HeadlessSession({ id: "sess1", workDir: dir, clientType: "claude", bin, statePath });
		s.start();
		expect(s.alive).toBe(true);
		await until(() => s.snapshot().includes("sess-abc-123") || s.runState() === "idle");
		expect(s.runState()).toBe("idle");

		s.input("pull latest");
		expect(s.runState()).toBe("thinking"); // set synchronously on send

		await until(() => s.runState() === "idle" && s.snapshot().includes("Done: pull latest"));
		const pane = s.snapshot();
		expect(pane).toMatch(/❯ \[\d{2}:\d{2}:\d{2}\] pull latest/); // your turn, echoed + timestamped
		expect(pane).toContain("⚙ Bash"); // tool use is surfaced
		expect(pane).toContain("Already up to date."); // tool result is surfaced
		expect(pane).toContain("Done: pull latest"); // Claude's REAL reply, not a scrape
		expect(s.runState()).toBe("idle"); // result event → idle is a fact

		s.stop();
		expect(s.alive).toBe(false);
	});

	it("does not crash when the binary is missing — surfaces the error instead", async () => {
		const s = new HeadlessSession({ id: "sx", workDir: dir, clientType: "claude", bin: join(dir, "no-such-binary-xyz") });
		// MUST NOT throw / emit an uncaught 'error' that would kill the runner.
		expect(() => s.start()).not.toThrow();
		s.input("hello"); // writing to a dead process must be safe too
		await until(() => !s.alive && s.snapshot().includes("cannot run"));
		expect(s.alive).toBe(false);
		expect(s.snapshot()).toContain("cannot run");
		expect(s.runState()).toBe("idle");
	});

	it("persists Claude's session id for --resume across runner restarts", async () => {
		const statePath = defaultStatePath(dir);
		const s = new HeadlessSession({ id: "sess2", workDir: dir, clientType: "claude", bin, statePath });
		s.start();
		await until(() => readState(statePath, "sess2") === "sess-abc-123");
		expect(readState(statePath, "sess2")).toBe("sess-abc-123");
		s.stop();

		// A fresh instance (runner restarted) reads the stored id, so start() resumes.
		const revived = new HeadlessSession({ id: "sess2", workDir: dir, clientType: "claude", bin, statePath });
		expect(revived.snapshot()).toBe(""); // no live process yet, but it knows the id
		// (resume is exercised by start(); we assert the persistence contract here.)
	});
});

function readState(path: string, id: string): string | null {
	try {
		return (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>)[id] ?? null;
	} catch {
		return null;
	}
}
