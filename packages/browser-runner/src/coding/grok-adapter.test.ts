/**
 * #1187 — a Grok run's tool calls are observable, from the stream xAI's CLI really writes.
 *
 * The fixture is a captured `grok --output-format streaming-json -p` run (Grok CLI 1.0.62, 2026-10-19; home path
 * and opaque signatures scrubbed): one terminal command that succeeds, one that fails. The adapter must turn it into
 * the same `tool_use` / `tool_result` / `turn_end` events Claude and Codex produce, and a real session must render
 * them into the pane the platform's evidence check reads.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineAdapterFor, type NormalizedEngineEvent } from "./engine-adapter.js";
import { createGrokEngineAdapter, grokStructuredArgs } from "./grok-adapter.js";
import { defaultStatePath, HeadlessSession } from "./headless.js";

const FIXTURE = new URL("./fixtures/grok-streaming-json-1.0.62/command-success-and-failure.ndjson", import.meta.url);
const lines = () => readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);
const parseAll = () => {
	const adapter = createGrokEngineAdapter();
	return lines().flatMap((l) => adapter.parseLine(l));
};
const shown = (events: NormalizedEngineEvent[]) => events.filter((e) => e.kind !== "meta");

describe("the Grok adapter reads the captured stream (#1187)", () => {
	it("each terminal command is a Bash tool call, settled by its exit code; the reply is ONE line, not a token per line", () => {
		const events = shown(parseAll());
		expect(events.map((e) => e.kind)).toEqual(["assistant_text", "tool_use", "tool_result", "tool_use", "tool_result", "assistant_text", "turn_end"]);
		const [intro, echo, echoed, ls, lsResult, done, end] = events;
		expect(intro).toEqual({ kind: "assistant_text", text: "I'll run the echo command first, then the failing `ls`." });
		expect(echo).toMatchObject({ kind: "tool_use", name: "Bash", input: { command: "echo PAGS_PROBE_42" } });
		expect(echoed).toMatchObject({ kind: "tool_result", toolUseId: (echo as { id: string }).id, content: "PAGS_PROBE_42\n", block: { is_error: false } });
		expect(ls).toMatchObject({ kind: "tool_use", name: "Bash", input: { command: "ls /definitely-not-here-pags" } });
		expect(lsResult).toMatchObject({ kind: "tool_result", toolUseId: (ls as { id: string }).id, block: { is_error: true } });
		expect((lsResult as { content: string }).content).toMatch(/No such file or directory/);
		expect(done).toEqual({ kind: "assistant_text", text: "done" });
		expect(end).toMatchObject({ kind: "turn_end", isError: false });
	});

	it("every line is understood: nothing in the stream would be dumped into the pane as raw JSON", () => {
		const adapter = createGrokEngineAdapter();
		for (const l of lines()) expect(adapter.parseLine(l).length, l.slice(0, 60)).toBeGreaterThan(0);
	});

	it("a turn that does not end on end_turn is an error, with its stop reason", () => {
		const a = createGrokEngineAdapter();
		expect(a.parseLine('{"type":"end","stopReason":"max_tokens"}')).toEqual([expect.objectContaining({ kind: "turn_end", isError: true, result: "stopped: max_tokens" })]);
	});
});

describe("the flags it needs (#1187)", () => {
	it("adds streaming-json and --no-auto-update to an old saved preset, keeping -p last", () => {
		expect(grokStructuredArgs(["--permission-mode", "bypassPermissions", "-p"])).toEqual(["--output-format", "streaming-json", "--no-auto-update", "--permission-mode", "bypassPermissions", "-p"]);
		expect(grokStructuredArgs(["--no-auto-update", "--output-format", "streaming-json", "-p"])).toEqual(["--no-auto-update", "--output-format", "streaming-json", "-p"]);
	});

	it("a preset that chose another output format on purpose stays raw", () => {
		expect(engineAdapterFor("grok", ["--output-format", "json", "-p"]).mode).toBe("raw");
		expect(engineAdapterFor("grok", ["--permission-mode", "bypassPermissions", "-p"]).mode).toBe("stream-json");
	});

	it("each session gets its own adapter, so one session's half-streamed reply cannot leak into another's", () => {
		const a = engineAdapterFor("grok", ["-p"]);
		const b = engineAdapterFor("grok", ["-p"]);
		expect(a).not.toBe(b);
		a.parseLine('{"type":"text","data":"secret half"}');
		expect(shown(b.parseLine('{"type":"end","stopReason":"end_turn"}'))).toEqual([expect.objectContaining({ kind: "turn_end" })]);
	});
});

/** A `grok` that writes the captured stream — or, with GROK_FAKE_OLD, refuses the structured flags like an old CLI. */
const FAKE_GROK = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(process.env.GROK_FAKE_LOG, JSON.stringify(argv) + "\\n");
if (process.env.GROK_FAKE_OLD && argv.includes("--output-format")) { process.stderr.write("error: unexpected argument '--output-format' found\\n"); process.exit(2); }
if (argv.includes("streaming-json")) process.stdout.write(readFileSync(process.env.GROK_FAKE_STREAM, "utf8"));
else process.stdout.write("plain reply\\n");
`;

describe("a Grok session renders its calls into the pane the evidence check reads (#1187)", () => {
	let dir: string;
	let bin: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-grok-stream-"));
		bin = join(dir, "grok");
		writeFileSync(bin, FAKE_GROK);
		chmodSync(bin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const until = async (cond: () => boolean, ms = 10_000) => {
		const end = Date.now() + ms;
		while (!cond()) {
			if (Date.now() > end) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 25));
		}
	};
	const runs = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
	const session = (id: string, log: string, env: Record<string, string> = {}) =>
		new HeadlessSession({ id, workDir: dir, clientType: "grok", command: "grok --permission-mode bypassPermissions -p", bin, statePath: defaultStatePath(join(dir, `state-${id}`)), env: { GROK_FAKE_LOG: log, GROK_FAKE_STREAM: FIXTURE.pathname, ...env } });

	it("the old saved preset runs structured, and both commands land in the pane as Bash calls with their outcomes", async () => {
		const log = join(dir, "stream.jsonl");
		const s = session("gs1", log);
		s.input("run the probe");
		await until(() => runs(log).length >= 1 && s.runState() === "idle");
		const argv = runs(log)[0];
		expect(argv).toEqual(expect.arrayContaining(["--output-format", "streaming-json", "--no-auto-update"]));
		expect(argv.at(-1)).toBe("run the probe");
		const pane = s.snapshot();
		// The same rendering a Claude run gets — the format the evidence check's call reader parses.
		expect(pane).toContain('⚙ Bash {"command":"echo PAGS_PROBE_42"}\n  ↳✓ PAGS_PROBE_42');
		expect(pane).toContain('⚙ Bash {"command":"ls /definitely-not-here-pags"}\n  ↳✗ ls: /definitely-not-here-pags: No such file or directory');
		expect(pane).toContain("I'll run the echo command first, then the failing `ls`.");
		// Understood, so not dumped: no raw event JSON in what a reader sees.
		expect(pane).not.toContain('"type":"usage"');
		expect(pane).not.toContain('"type":"text"');
		s.stop();
	}, 30_000);

	it("an older CLI that refuses the flags: the turn is retried once raw, WITHOUT them", async () => {
		const log = join(dir, "old.jsonl");
		const s = session("gs2", log, { GROK_FAKE_OLD: "1" });
		s.input("hello");
		await until(() => runs(log).length >= 2 && s.runState() === "idle");
		const [refused, retried] = runs(log);
		expect(refused).toContain("--output-format");
		expect(retried).not.toContain("--output-format");
		expect(retried).not.toContain("--no-auto-update");
		expect(s.snapshot()).toContain("plain reply");
		s.stop();
	}, 30_000);
});

/**
 * #1197 — a Grok FILE CHANGE is an `Edit`, so the evidence check's "files changed after the last green run" sees it.
 *
 * The stream below is SYNTHETIC: written from the shape of ACP tool calls (`kind`, `locations: [{path}]`, both present on the captured
 * terminal call), NOT captured from a Grok edit — no signed-in Grok was on hand. The captured stream above stays the only
 * evidence of Grok's own output; this pins the mapping so a real capture can replace it.
 */
describe("a non-terminal Grok tool (#1197)", () => {
	const call = (extra: Record<string, unknown>) => JSON.stringify({ type: "tool_call", toolCallId: "call-edit-0", title: "search_replace", status: "pending", content: [], ...extra });
	const first = (line: string) => {
		const events = createGrokEngineAdapter().parseLine(line);
		return events.find((e) => e.kind === "tool_use") as Extract<NormalizedEngineEvent, { kind: "tool_use" }>;
	};

	it("an edit (ACP kind `edit`) is an Edit with the path ACP names in `locations`", () => {
		const use = first(call({ kind: "edit", toolName: "search_replace", rawInput: { old_string: "a", new_string: "b" }, locations: [{ path: "/work/app/src/index.ts", line: 3 }] }));
		expect(use.name).toBe("Edit");
		expect(use.input).toEqual({ file_path: "/work/app/src/index.ts" });
	});
	it("falls back to a path-like field of the raw input, and keeps the Edit even when no path can be found", () => {
		expect(first(call({ kind: "edit", toolName: "search_replace", rawInput: { file_path: "src/a.ts", old_string: "x" }, locations: [] })).input).toEqual({ file_path: "src/a.ts" });
		expect(first(call({ kind: "edit", toolName: "search_replace", rawInput: { path: "src/b.ts" } })).input).toEqual({ file_path: "src/b.ts" });
		const none = first(call({ kind: "edit", toolName: "search_replace", rawInput: { weird: 1 } }));
		expect(none.name).toBe("Edit");
		expect(none.input).toEqual({});
	});
	it("the edit tool is recognised by name too, in case a build reports it with another kind; a delete or move is a file change", () => {
		expect(first(call({ kind: "other", toolName: "search_replace", rawInput: { file_path: "src/c.ts" } })).name).toBe("Edit");
		expect(first(call({ kind: "delete", toolName: "x", locations: [{ path: "/w/old.ts" }] })).input).toEqual({ file_path: "/w/old.ts" });
		expect(first(call({ kind: "move", toolName: "x", locations: [{ path: "/w/moved.ts" }] })).name).toBe("Edit");
	});
	it("never puts the old and new text in the pane line: the path alone is the evidence", () => {
		const use = first(call({ kind: "edit", toolName: "search_replace", rawInput: { file_path: "a.ts", old_string: "SECRET_OLD".repeat(30), new_string: "SECRET_NEW".repeat(30) } }));
		expect(JSON.stringify(use.input)).not.toContain("SECRET");
	});
	it("a read, a search and a listing are passed through under their own name, unchanged", () => {
		for (const [kind, toolName] of [["read", "read_file"], ["search", "grep"], ["search", "list_dir"]] as const) {
			const use = first(call({ kind, toolName, rawInput: { path: "src" } }));
			expect(use.name).toBe(toolName);
			expect(use.input).toEqual({ path: "src" });
		}
	});
	it("the terminal tool is still a Bash call", () => {
		expect(first(call({ kind: "execute", toolName: "run_terminal_command", rawInput: { command: "npm test" } })).name).toBe("Bash");
	});
	it("an edit's result still settles the call, and a failed edit is an error", () => {
		const adapter = createGrokEngineAdapter();
		adapter.parseLine(call({ kind: "edit", toolName: "search_replace", rawInput: { file_path: "a.ts" } }));
		const done = adapter.parseLine(JSON.stringify({ type: "tool_call_update", toolCallId: "call-edit-0", status: "failed", content: [{ type: "content", content: { type: "text", text: "no match" } }], rawOutput: null }));
		expect(done[0]).toMatchObject({ kind: "tool_result", toolUseId: "call-edit-0", content: "no match" });
		expect((done[0] as { block: { is_error: boolean } }).block.is_error).toBe(true);
	});
});
