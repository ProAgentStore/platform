/**
 * #1156: Grok carries its own conversation across one-shot turns by an id the runner chose — `-s <uuid>` to start it,
 * `-r <uuid>` to resume it — pure rules, then the real HeadlessSession against a fake `grok` that logs its argv.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { afterGrokTurn, grokRejectedContinuity, grokTurnArgs, isGrokConversationId, newGrokConversation, reportedGrokSession } from "./grok-continuity.js";
import { HeadlessSession } from "./headless.js";
import { defaultStatePath, readState } from "./headless-state.js";

const ID = "1e88dd3f-332f-4f10-9806-ae7baf58c0ff";
const PRESET = ["--permission-mode", "bypassPermissions", "-p"];
/** What a session spawns from that preset: the structured-output flags in front (#1187, grok-adapter.ts). */
const SPAWNED = ["--output-format", "streaming-json", "--no-auto-update", ...PRESET];

describe("the turn's argv (#1156)", () => {
	it("starts a conversation with -s, resumes it with -r, and leaves the turn as -p's value at the end", () => {
		expect(grokTurnArgs(PRESET, "fix it", { id: ID, started: false })).toEqual(["-s", ID, ...PRESET, "fix it"]);
		expect(grokTurnArgs(PRESET, "and the tests", { id: ID, started: true })).toEqual(["-r", ID, ...PRESET, "and the tests"]);
		expect(grokTurnArgs(PRESET, "plain", null)).toEqual([...PRESET, "plain"]);
	});

	it("only a UUID is an id — a value read back from disk that is not one never reaches argv", () => {
		expect(isGrokConversationId(ID)).toBe(true);
		expect(isGrokConversationId(newGrokConversation().id)).toBe(true);
		for (const bad of ["", "--continue", "abc", `${ID}; rm -rf ~`, null]) expect(isGrokConversationId(bad)).toBe(false);
	});
});

describe("what a finished turn means (#1156)", () => {
	const fresh = { id: ID, started: false };
	it("success: the CLI holds it now — remember it, and resume next time", () => {
		expect(afterGrokTurn(fresh, { code: 0, rejected: false })).toEqual({ next: { id: ID, started: true }, persist: ID, disable: false });
	});
	it("failure: forget it, so the next turn starts a clean conversation (it may be half-made)", () => {
		expect(afterGrokTurn({ id: ID, started: true }, { code: 1, rejected: false })).toEqual({ next: null, persist: null, disable: false });
	});
	it("the flags themselves refused: run without continuity from now on", () => {
		expect(afterGrokTurn(fresh, { code: 2, rejected: true })).toEqual({ next: null, persist: null, disable: true });
	});
	it("recognises an argument rejection — and nothing broader", () => {
		for (const l of ["error: unexpected argument '-s' found", "error: invalid value 'x' for '--session-id <SESSION_ID>': must be a valid UUID", "Error: session 1e88… not found", "error: session already exists"]) {
			expect(grokRejectedContinuity([l])).toBe(true);
		}
		for (const l of ["Not signed in. To authenticate without a browser, run:", "error: tests failed", "Session summary: 3 files changed", "  ↳ Error: session not found (quoted from a test the agent ran)", "the session was not found in redis"]) {
			expect(grokRejectedContinuity([l])).toBe(false);
		}
	});
});

/**
 * Real processes: a fake `grok` that appends its argv to a log and answers. GROK_FAKE_REJECT makes it refuse any
 * continuity flag the way a CLI that does not know them would (an argument error, before doing anything);
 * GROK_FAKE_FAIL_ONCE makes the first resumed turn fail.
 */
const FAKE_GROK = `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(process.env.GROK_FAKE_LOG, JSON.stringify(argv) + "\\n");
const flagged = argv[0] === "-s" || argv[0] === "-r";
if (process.env.GROK_FAKE_REJECT && flagged) { process.stderr.write("error: unexpected argument '" + argv[0] + "' found\\n"); process.exit(2); }
if (process.env.GROK_FAKE_FAIL_ONCE && argv[0] === "-r" && !existsSync(process.env.GROK_FAKE_FAIL_ONCE)) { writeFileSync(process.env.GROK_FAKE_FAIL_ONCE, "1"); process.stderr.write("error: model overloaded\\n"); process.exit(1); }
process.stdout.write("done: " + argv[argv.length - 1] + "\\n");
`;

describe("a Grok session, in real processes (#1156)", () => {
	let dir: string;
	let bin: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-grok-"));
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
	const turn = async (s: HeadlessSession, text: string, count: number, log: string) => {
		s.input(text);
		await until(() => runs(log).length >= count && s.runState() === "idle");
	};
	const session = (id: string, log: string, env: Record<string, string> = {}) =>
		new HeadlessSession({ id, workDir: dir, clientType: "grok", command: "grok --permission-mode bypassPermissions -p", bin, statePath: defaultStatePath(join(dir, `state-${id}`)), env: { GROK_FAKE_LOG: log, ...env } });

	it("turn one makes a conversation under a fresh UUID; turn two — and a restarted runner — resume exactly that one", async () => {
		const log = join(dir, "resume.jsonl");
		const s = session("g1", log);
		await turn(s, "first", 1, log);
		const [flag, id] = runs(log)[0];
		expect(flag).toBe("-s");
		expect(isGrokConversationId(id)).toBe(true);
		expect(runs(log)[0].slice(2)).toEqual([...SPAWNED, "first"]);
		await turn(s, "second", 2, log);
		expect(runs(log)[1].slice(0, 2)).toEqual(["-r", id]);
		expect(readState(defaultStatePath(join(dir, "state-g1")), "g1", "grok")).toBe(id);
		s.stop();

		// `pags up` restarted: a new session object, the same id, and the CLI's conversation is resumed — not restarted.
		const after = session("g1", log);
		await turn(after, "third", 3, log);
		expect(runs(log)[2].slice(0, 2)).toEqual(["-r", id]);
		after.stop();
	}, 30_000);

	it("a failed resume forgets the id: the next turn starts a clean conversation under a new one", async () => {
		const log = join(dir, "fail.jsonl");
		const s = session("g2", log, { GROK_FAKE_FAIL_ONCE: join(dir, "failed-once") });
		await turn(s, "one", 1, log);
		const first = runs(log)[0][1];
		await turn(s, "two", 2, log); // -r fails once
		expect(runs(log)[1].slice(0, 2)).toEqual(["-r", first]);
		await turn(s, "three", 3, log);
		expect(runs(log)[2][0]).toBe("-s");
		expect(runs(log)[2][1]).not.toBe(first);
		s.stop();
	}, 30_000);

	it("a CLI that rejects the flags runs the SAME turn again without them — once — and the session goes on one-shot", async () => {
		const log = join(dir, "reject.jsonl");
		const s = session("g3", log, { GROK_FAKE_REJECT: "1" });
		await turn(s, "do the thing", 2, log);
		expect(runs(log)[0][0]).toBe("-s");
		expect(runs(log)[1]).toEqual([...SPAWNED, "do the thing"]);
		expect(s.snapshot()).toContain("rejected its session flags");
		await turn(s, "next", 3, log);
		expect(runs(log)[2]).toEqual([...SPAWNED, "next"]); // no continuity flags again
		expect(runs(log)).toHaveLength(3);
		s.stop();
	}, 30_000);

	it("still sends the platform's replay with every turn — its own memory is not trusted until a signed-in run proves it", () => {
		expect(session("g4", join(dir, "x.jsonl")).holdsConversationThisTurn).toBe(false);
	});
});

/** #1197 — the session id Grok's `end` event reports is cross-checked against the one the runner asked for. */
describe("the session Grok reports (#1197)", () => {
	const ASKED = "11111111-2222-4333-8444-555555555555";
	const THEIRS = "01a14f36-85b6-7763-8935-36a11d31018b"; // the shape of the captured `end` event's sessionId (a UUIDv7)

	it("takes only a UUID from the event — it reaches argv on the next turn", () => {
		expect(reportedGrokSession({ type: "end", sessionId: THEIRS })).toBe(THEIRS);
		for (const bad of [{ sessionId: "--dangerous" }, { sessionId: "x; rm -rf ~" }, { sessionId: 5 }, {}, null, "str", undefined]) expect(reportedGrokSession(bad)).toBeNull();
	});
	it("the same id (the CLI honoured -s) changes nothing: the conversation is simply marked started", () => {
		const after = afterGrokTurn({ id: ASKED, started: false }, { code: 0, rejected: false, reported: ASKED });
		expect(after).toEqual({ next: { id: ASKED, started: true }, persist: ASKED, disable: false });
		expect(after.adopted).toBeUndefined();
	});
	it("a different id: the CLI holds the thread under ITS id, so the next turn resumes that one — and it is persisted", () => {
		const after = afterGrokTurn({ id: ASKED, started: false }, { code: 0, rejected: false, reported: THEIRS });
		expect(after).toEqual({ next: { id: THEIRS, started: true }, persist: THEIRS, disable: false, adopted: THEIRS });
		expect(grokTurnArgs([], "next", after.next)).toEqual(["-r", THEIRS, "next"]);
	});
	it("a failed turn adopts nothing, and no report means the runner's own id stands", () => {
		expect(afterGrokTurn({ id: ASKED, started: true }, { code: 1, rejected: false, reported: THEIRS })).toEqual({ next: null, persist: null, disable: false });
		expect(afterGrokTurn({ id: ASKED, started: false }, { code: 0, rejected: false })).toMatchObject({ persist: ASKED });
		expect(afterGrokTurn({ id: ASKED, started: false }, { code: 0, rejected: false, reported: null })).toMatchObject({ persist: ASKED });
	});
});

/**
 * #1197 — a whole Grok turn through a real session: the file change is an Edit in the pane the evidence check reads, the turn's
 * spend reaches the usage queue as xai, and a session id the CLI names (not the one asked for) is the one the next turn resumes.
 * The stream is synthetic for the edit (see grok-adapter.test.ts) and shaped like the captured `end` event.
 */
const FAKE_STREAMING_GROK = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(process.env.GROK_FAKE_LOG, JSON.stringify(argv) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "tool_call", toolCallId: "call-1", title: "search_replace", kind: "edit", status: "pending", toolName: "search_replace", rawInput: { file_path: "src/app.ts", old_string: "a", new_string: "b" }, content: [], locations: [{ path: "src/app.ts" }] });
out({ type: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "edited" } }], rawOutput: null });
out({ type: "end", stopReason: "end_turn", sessionId: process.env.GROK_FAKE_SESSION, requestId: process.env.GROK_FAKE_REQUEST, usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 0, reasoning_tokens: 10, total_tokens: 1450 }, total_cost_usd: 0.0123, modelUsage: { "grok-4.7-build": { costUSD: 0.0123 } } });
`;

describe("a Grok turn end to end (#1197)", () => {
	let dir: string;
	let bin: string;
	const THEIRS = "01a14f36-85b6-7763-8935-36a11d31018b";
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pags-grok-e2e-"));
		bin = join(dir, "grok");
		writeFileSync(bin, FAKE_STREAMING_GROK);
		chmodSync(bin, 0o755);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const runs = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
	const settle = async (s: HeadlessSession, log: string, count: number) => {
		const end = Date.now() + 10_000;
		while (!(runs(log).length >= count && s.runState() === "idle")) {
			if (Date.now() > end) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 25));
		}
	};

	it("renders the edit with its path, banks the spend as xai, and resumes the session Grok reported", async () => {
		const log = join(dir, "e2e.jsonl");
		const s = new HeadlessSession({
			id: "e2e",
			workDir: dir,
			clientType: "grok",
			command: "grok --permission-mode bypassPermissions -p",
			bin,
			statePath: defaultStatePath(join(dir, "state-e2e")),
			env: { GROK_FAKE_LOG: log, GROK_FAKE_SESSION: THEIRS, GROK_FAKE_REQUEST: "req-0001-abcd" },
		});
		s.input("change a to b");
		await settle(s, log, 1);
		const pane = s.snapshot();
		expect(pane).toMatch(/Edit/);
		expect(pane).toContain("src/app.ts");
		expect(pane).not.toMatch(/old_string|new_string/);
		expect(pane).toContain(`holds this conversation as ${THEIRS}`);
		const usage = s.takeUsage();
		expect(usage).toEqual([expect.objectContaining({ provider: "xai", model: "grok-4.7-build", inputTokens: 1000, outputTokens: 50, cacheReadTokens: 400, costUsd: 0.0123, id: "grok:req-0001-abcd" })]);
		expect(s.takeUsage()).toEqual([]); // drained, not re-reported

		s.input("and again");
		await settle(s, log, 2);
		expect(runs(log)[0][0]).toBe("-s");
		expect(runs(log)[1].slice(0, 2)).toEqual(["-r", THEIRS]); // the session the CLI named, not the one this runner made up
		s.stop();
	}, 30_000);
});
