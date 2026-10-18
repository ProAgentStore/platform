/**
 * #1201 — what `coding_session_capture` shows for a Grok session: each turn's readable output, and a failed turn's
 * error and exit code — never an empty pane between turns.
 *
 * Grok runs one process per turn (`-p --output-format streaming-json`). The report was `paneChars: 0` between turns,
 * from the plain-text preset before #1187. Checked live on 2026-10-19 against xAI's Grok CLI 1.0.62 through this
 * runner's own `HeadlessSession`: a good turn rendered its call, result and reply; an invalid model rendered Grok's
 * stderr and `[grok exited with code 1]`. These tests replay exactly those two turns — the captured stream
 * (`fixtures/grok-streaming-json-1.0.62/`) and the stderr Grok printed, verbatim — so the behaviour stays pinned.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultStatePath, HeadlessSession } from "./headless.js";

const FIXTURE = new URL("./fixtures/grok-streaming-json-1.0.62/command-success-and-failure.ndjson", import.meta.url).pathname;

/** Grok 1.0.62's own words for an unknown model, as it printed them to stderr before exiting 1. */
const BAD_MODEL_STDERR = [
	`error: Couldn't set model 'grok-9-imaginary': Invalid params: "unknown model id". Run 'grok models' to see available models.`,
	`Error: Couldn't set model 'grok-9-imaginary': Invalid params: "unknown model id". Run 'grok models' to see available models.`,
];

/** A `grok` that replays the captured stream, or — with `-m grok-9-imaginary` — the captured failure. */
const FAKE_GROK = `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("grok-9-imaginary")) { process.stderr.write(${JSON.stringify(`${BAD_MODEL_STDERR.join("\n")}\n`)}); process.exit(1); }
process.stdout.write(readFileSync(${JSON.stringify(FIXTURE)}, "utf8"));
`;

describe("the Grok pane coding_session_capture reads (#1201)", () => {
	let dir: string;
	let bin: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-grok-pane-"));
		bin = join(dir, "grok");
		writeFileSync(bin, FAKE_GROK);
		chmodSync(bin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const idle = async (s: HeadlessSession) => {
		const end = Date.now() + 10_000;
		await new Promise((r) => setTimeout(r, 50));
		while (s.runState() !== "idle") {
			if (Date.now() > end) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	const session = (id: string, command: string) => new HeadlessSession({ id, workDir: dir, clientType: "grok", command, bin, statePath: defaultStatePath(join(dir, `state-${id}`)) });

	it("after a good turn: the turn's readable output — its reply, the call it ran, and the call's result", async () => {
		const s = session("good", "grok --permission-mode bypassPermissions -p");
		s.input("run the probe");
		await idle(s);
		const pane = s.snapshot();
		expect(pane.length).toBeGreaterThan(0);
		expect(pane).toContain("❯");
		expect(pane).toContain('⚙ Bash {"command":"echo PAGS_PROBE_42"}\n  ↳✓ PAGS_PROBE_42');
		expect(pane).toContain("done");
		expect(s.lastTurn).toMatchObject({ verdict: "ok" });
		s.stop();
	});

	it("after a FAILED turn: the CLI's error, verbatim, and its exit code — in the pane and on lastTurn", async () => {
		const s = session("bad", "grok --permission-mode bypassPermissions -m grok-9-imaginary -p");
		s.input("run the probe");
		await idle(s);
		const pane = s.snapshot();
		expect(pane).toContain(`[grok] ${BAD_MODEL_STDERR[0]}`);
		expect(pane).toContain("[grok exited with code 1]");
		expect(s.lastTurn).toMatchObject({ verdict: "failed", exitCode: 1 });
		expect(s.lastTurn?.detail).toContain("unknown model id");
		s.stop();
	});

	it("between turns the pane keeps what earlier turns printed — a one-shot engine's capture is never empty after a turn", async () => {
		const s = session("multi", "grok --permission-mode bypassPermissions -p");
		s.input("first");
		await idle(s);
		const afterFirst = s.snapshot();
		s.input("second");
		await idle(s);
		const afterSecond = s.snapshot();
		expect(afterSecond.startsWith(afterFirst)).toBe(true);
		expect(afterSecond.match(/⚙ Bash \{"command":"echo PAGS_PROBE_42"\}/g)).toHaveLength(2);
		s.stop();
	});
});
