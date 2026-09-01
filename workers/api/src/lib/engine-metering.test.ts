import { describe, expect, it, vi } from "vitest";
import {
	classifyEngineMetering,
	describeUnmetered,
	emptyUnmeteredSummary,
	isAiCli,
	noteUnmeteredDrive,
	noteUnmeteredHeadlessDrive,
	normalizePaneCommand,
	recordUnmeteredEngineActivity,
	unmeteredRowId,
	unmeteredUsageSummary,
	UNMETERED_WINDOW_MAX_DAYS,
} from "./engine-metering.js";
import type { Env } from "../types.js";

/** A D1 double that records the statements it was asked to run. */
function fakeDb(first: Record<string, unknown> | null = null) {
	const runs: Array<{ sql: string; args: unknown[] }> = [];
	const DB = {
		prepare(sql: string) {
			return {
				// Bind-less .run() — reached by logEvent's opportunistic retention DELETE
				// (`Math.random() < 0.01`). Without this the catch block in logEvent emits
				// `[events] failed to persist: … .run is not a function` (#680).
				async run() { return { success: true }; },
				bind(...args: unknown[]) {
					return {
						async run() {
							runs.push({ sql, args });
							return { success: true };
						},
						async first() {
							runs.push({ sql, args });
							return first;
						},
					};
				},
			};
		},
	};
	return { runs, env: { DB } as unknown as Env };
}

describe("normalizePaneCommand", () => {
	it("reduces a path and arguments to the bare binary name", () => {
		expect(normalizePaneCommand("/opt/homebrew/bin/claude --resume abc")).toBe("claude");
		expect(normalizePaneCommand("CLAUDE")).toBe("claude");
	});

	it("returns empty for anything that carries no name — UNKNOWN, never a name", () => {
		expect(normalizePaneCommand(null)).toBe("");
		expect(normalizePaneCommand(undefined)).toBe("");
		expect(normalizePaneCommand("   ")).toBe("");
	});
});

describe("isAiCli", () => {
	it("recognises the known coding CLIs", () => {
		for (const c of ["claude", "codex", "grok", "aider", "/usr/local/bin/gemini"]) {
			expect(isAiCli(c), c).toBe(true);
		}
	});

	it("does not claim an unknown or unreadable command is one", () => {
		expect(isAiCli("zsh")).toBe(false);
		expect(isAiCli(null)).toBe(false);
	});
});

describe("classifyEngineMetering", () => {
	it("meters structured engines only when the Pilot drives them as child processes", () => {
		expect(classifyEngineMetering("headless", "claude").metered).toBe(true);
		expect(classifyEngineMetering("headless", "codex").metered).toBe(true);
	});

	it("does NOT meter Claude Code through a terminal — the driver decides, not the engine", () => {
		// The bug in one line: same binary, same repo, same spend; a pane just cannot report it.
		const v = classifyEngineMetering("terminal", "claude");
		expect(v.metered).toBe(false);
		expect(v.reason).toContain("claude");
	});

	it("does not meter engines with no structured turn event under either driver", () => {
		expect(classifyEngineMetering("headless", "grok").metered).toBe(false);
		expect(classifyEngineMetering("terminal", "codex").metered).toBe(false);
	});

	it("is unmetered, not metered, when the engine is unknown", () => {
		// Defaulting an unrecognised engine to "measured" would silently claim its absent rows are
		// a real zero — the exact failure this module exists for.
		expect(classifyEngineMetering("headless", null).metered).toBe(false);
		expect(classifyEngineMetering("terminal", "").metered).toBe(false);
	});

	it("always explains itself in a sentence a page can print", () => {
		for (const v of [
			classifyEngineMetering("headless", "claude"),
			classifyEngineMetering("headless", "codex"),
			classifyEngineMetering("terminal", "zsh"),
		]) {
			expect(v.reason.length).toBeGreaterThan(20);
		}
	});
});

describe("describeUnmetered", () => {
	it("names the CLI when one was observed", () => {
		expect(describeUnmetered({ driver: "terminal", target: "tmux:work", activeCommand: "claude" })).toContain("Drove claude");
	});

	it("says the command was UNREADABLE rather than implying nothing ran", () => {
		const msg = describeUnmetered({ driver: "terminal", target: "tmux:work", activeCommand: null });
		expect(msg).toContain("could not be read");
		expect(msg).not.toContain("no AI");
	});

	it("still records an unmeasured drive when the pane held a plain shell", () => {
		// A pane showing `zsh` may have run `claude -p` between two reads. "any AI CLI spend" is the
		// honest hedge; "nothing was spent" would be a claim we cannot make.
		const msg = describeUnmetered({ driver: "terminal", target: "tmux:work", activeCommand: "zsh" });
		expect(msg).toContain("zsh");
		expect(msg).toContain("NOT measured");
	});

	it("never states a cost — there is no honest number to state", () => {
		for (const cmd of ["claude", "zsh", null]) {
			expect(describeUnmetered({ driver: "terminal", target: "tmux:w", activeCommand: cmd })).not.toMatch(/\$|\bzero\b|\b0\b/);
		}
	});
});

describe("unmeteredRowId", () => {
	it("collapses repeated drives of the same target on the same day", () => {
		const a = unmeteredRowId("i1", "2026-08-07", "tmux:w", true);
		expect(unmeteredRowId("i1", "2026-08-07", "tmux:w", true)).toBe(a);
	});

	it("keeps an AI-CLI sighting apart from an unrecognised one", () => {
		// Otherwise a pane that starts as a shell and later runs Claude Code is swallowed by the
		// first, less specific row.
		expect(unmeteredRowId("i1", "2026-08-07", "tmux:w", true)).not.toBe(unmeteredRowId("i1", "2026-08-07", "tmux:w", false));
	});

	it("separates instances, days and targets", () => {
		const base = unmeteredRowId("i1", "2026-08-07", "tmux:w", true);
		expect(unmeteredRowId("i2", "2026-08-07", "tmux:w", true)).not.toBe(base);
		expect(unmeteredRowId("i1", "2026-08-08", "tmux:w", true)).not.toBe(base);
		expect(unmeteredRowId("i1", "2026-08-07", "tmux:x", true)).not.toBe(base);
	});
});

describe("recordUnmeteredEngineActivity", () => {
	const ctx = { userId: "u1", instanceId: "i1", now: Date.parse("2026-08-07T09:00:00Z") };

	it("writes a trace row, not a usage row", () => {
		// An ai_usage row would have to carry a cost, and the only honest cost here is unknown.
		const { runs, env } = fakeDb();
		return recordUnmeteredEngineActivity(env, ctx, { driver: "terminal", target: "tmux:w", activeCommand: "claude" }).then(() => {
			expect(runs).toHaveLength(1);
			expect(runs[0].sql).toContain("INSERT INTO agent_events");
			expect(runs[0].sql).not.toContain("ai_usage");
		});
	});

	it("stamps the day into the id so a chatty Loop writes one row, not hundreds", async () => {
		const { runs, env } = fakeDb();
		await recordUnmeteredEngineActivity(env, ctx, { driver: "terminal", target: "tmux:w", activeCommand: "claude" });
		await recordUnmeteredEngineActivity(env, ctx, { driver: "terminal", target: "tmux:w", activeCommand: "claude" });
		expect(runs[0].args[0]).toBe(runs[1].args[0]);
		expect(runs[0].args[0]).toBe("unmetered:i1:2026-08-07:tmux:w:ai");
	});

	it("records whether the pane command could be read at all", async () => {
		const { runs, env } = fakeDb();
		await recordUnmeteredEngineActivity(env, ctx, { driver: "terminal", target: "tmux:w", activeCommand: null });
		const context = JSON.parse(String(runs[0].args[9]));
		expect(context.paneCommandReadable).toBe(false);
		expect(context.paneCommand).toBeNull();
		expect(context.metered).toBe(false);
	});

	it("does nothing without an owner or an instance to attribute it to", async () => {
		const { runs, env } = fakeDb();
		await recordUnmeteredEngineActivity(env, { userId: "", instanceId: "i1" }, { driver: "terminal", target: "t" });
		await recordUnmeteredEngineActivity(env, { userId: "u1", instanceId: "" }, { driver: "terminal", target: "t" });
		await recordUnmeteredEngineActivity(env, { userId: "u1", instanceId: "i1" }, { driver: "terminal", target: "" });
		expect(runs).toHaveLength(0);
	});
});

describe("noteUnmeteredDrive", () => {
	it("treats a non-string activeCommand as unreadable, not as empty", async () => {
		// An older runner sends no field at all. Coercing that to "" would claim we looked.
		const { runs, env } = fakeDb();
		await noteUnmeteredDrive(env, { userId: "u1", instanceId: "i1" }, { driver: "terminal", target: "tmux:w", activeCommand: undefined });
		expect(JSON.parse(String(runs[0].args[9])).paneCommandReadable).toBe(false);
	});

	it("skips silently when the tool call has no user or instance", async () => {
		const { runs, env } = fakeDb();
		await noteUnmeteredDrive(env, {}, { driver: "terminal", target: "tmux:w" });
		expect(runs).toHaveLength(0);
	});

	it("never throws when the ledger write blows up", async () => {
		// Spy so the `[events] failed to persist: …` line is captured as a positive assertion
		// rather than printed as noise — the same technique on-error.test.ts uses.
		const errors: unknown[][] = [];
		const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
		try {
			const env = {
				DB: {
					prepare() {
						throw new Error("d1 down");
					},
				},
			} as unknown as Env;
			await expect(noteUnmeteredDrive(env, { userId: "u1", instanceId: "i1" }, { driver: "terminal", target: "t" })).resolves.toBeUndefined();
			expect(errors.some((a) => String(a[0]).includes("[events] failed to persist"))).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("noteUnmeteredHeadlessDrive — the other row of the 2x2 (#556)", () => {
	/** The trace row's `context` blob, as it was bound. */
	const contextOf = (run: { args: unknown[] }) => JSON.parse(String(run.args[9])) as Record<string, unknown>;

	it("records the absence for a raw engine, naming the CLI and the driver", async () => {
		const { runs, env } = fakeDb();
		await noteUnmeteredHeadlessDrive(env, { userId: "u1", instanceId: "i1" }, { id: "csess-9", clientType: "grok" });
		expect(runs).toHaveLength(1);
		const ctx = contextOf(runs[0]);
		expect(ctx.driver).toBe("headless");
		// `aiCli: true` is what separates "an AI CLI ran unmeasured" from "we could not see what
		// was in there" — and unlike a pane's foreground command it cannot be an unreadable
		// observation here, because the platform chose the binary it spawned.
		expect(ctx.aiCli).toBe(true);
		expect(ctx.paneCommand).toBe("grok");
		expect(String(runs[0].args[8])).toMatch(/NOT measured/);
	});

	it("records NOTHING for headless Codex exec --json — token usage already has a ledger row", async () => {
		const { runs, env } = fakeDb();
		await noteUnmeteredHeadlessDrive(env, { userId: "u1", instanceId: "i1" }, { id: "csess-9", clientType: "codex" });
		expect(runs).toHaveLength(0);
	});

	it("targets the runner's own engineLabel shape, so the trace names what both sides call it", async () => {
		const { runs, env } = fakeDb();
		await noteUnmeteredHeadlessDrive(env, { userId: "u1", instanceId: "i1" }, { id: "csess-9", clientType: "grok" });
		expect(contextOf(runs[0]).target).toBe("grok:csess-9");
	});

	it("records NOTHING for Claude Code — a measured turn already has a real ledger row", async () => {
		// The distinction the classifier exists to draw. Writing "this was not measured" beside a
		// measurement would be false, and would inflate the figure the Usage page prints as what
		// its total leaves out.
		const { runs, env } = fakeDb();
		await noteUnmeteredHeadlessDrive(env, { userId: "u1", instanceId: "i1" }, { id: "csess-9", clientType: "claude" });
		expect(runs).toHaveLength(0);
	});

	it("keys one row per session-day, so a Loop's forty drives do not become forty rows", async () => {
		// The volume guard. `unmeteredRowId` is coarse on purpose and `logEvent` is
		// ON CONFLICT DO NOTHING, so repeated drives collapse. Making the id finer — per drive,
		// per turn — is what would turn a day of raw-engine work into a trace nobody can read.
		const { runs, env } = fakeDb();
		for (let i = 0; i < 40; i++) {
			await noteUnmeteredHeadlessDrive(env, { userId: "u1", instanceId: "i1" }, { id: "csess-9", clientType: "grok" });
		}
		expect(new Set(runs.map((r) => String(r.args[0]))).size).toBe(1);
	});

	it("says something honest about an engine whose clientType is missing", async () => {
		// Never "nothing was spent". An unknown engine is unmeasurable until proven otherwise —
		// the asymmetry `AI_CLI_COMMANDS` is documented to preserve.
		const { runs, env } = fakeDb();
		await noteUnmeteredHeadlessDrive(env, { userId: "u1", instanceId: "i1" }, { id: "csess-9", clientType: null });
		expect(runs).toHaveLength(1);
		expect(contextOf(runs[0]).aiCli).toBe(false);
		expect(contextOf(runs[0]).target).toBe("engine:csess-9");
	});
});

describe("unmeteredUsageSummary", () => {
	it("clamps the window to the trace's retention so the count cannot outrun its data", async () => {
		const { env } = fakeDb({ drives: 3, instances: 1, last_at: 5, ai_drives: 2 });
		const s = await unmeteredUsageSummary(env, "u1", { rangeDays: 90 });
		expect(s.windowDays).toBe(UNMETERED_WINDOW_MAX_DAYS);
		expect(s.drives).toBe(3);
		expect(s.aiCliDrives).toBe(2);
	});

	it("counts terminal-days, not invocations — a pane driven all day is one drive (#659)", async () => {
		// `drives` is a COUNT(*) over the `agent_events` table where each row's id is
		// `unmeteredRowId(instanceId, day, target, aiCli)` — coarse by design, deduplicated via
		// INSERT … ON CONFLICT DO NOTHING. The Usage page MUST label this "terminal-days" and
		// explain the dedup, not call it a count of drives, which understates the gap.
		//
		// The DB stub here returns 1 regardless of how many `terminal_send_keys` calls happened,
		// which is the same result the real DB gives after dedup: one pane driven for a full day
		// produces exactly one row. The label "drives" without this qualification is the bug #659 fixes.
		const { env } = fakeDb({ drives: 1, instances: 1, last_at: Date.now(), ai_drives: 1 });
		const s = await unmeteredUsageSummary(env, "u1", { rangeDays: 1 });
		expect(s.drives).toBe(1); // one terminal-day, regardless of how many sends occurred
		expect(s.aiCliDrives).toBe(1);
	});

	it("keeps a shorter requested range", async () => {
		const { env } = fakeDb({ drives: 0, instances: 0, last_at: null, ai_drives: 0 });
		expect((await unmeteredUsageSummary(env, "u1", { rangeDays: 7 })).windowDays).toBe(7);
	});

	it("degrades to 'nothing recorded' rather than failing the page", async () => {
		const env = {
			DB: {
				prepare() {
					throw new Error("d1 down");
				},
			},
		} as unknown as Env;
		expect(await unmeteredUsageSummary(env, "u1", { rangeDays: 7 })).toEqual(emptyUnmeteredSummary(7));
	});
});

// ── #498: a rewritten argv is not a program name ────────────────────────────
//
// Measured: `#{pane_current_command}` answered `2.1.226` (Claude Code's version) for a pane whose
// process `comm` was `claude`, so `isAiCli` was false and `aiCliDrives` stayed 0 across a week of
// driving it. The runner now asks the process tree for the real name; this half makes sure the
// residue — a value that carries no name at all — is reported as unreadable rather than named.
describe("a version string is not a command (#498)", () => {
	it("normalizes to nothing, so nothing claims it is a program", () => {
		expect(normalizePaneCommand("2.1.226")).toBe("");
		expect(normalizePaneCommand("v0.4.45")).toBe("");
		expect(normalizePaneCommand("/opt/homebrew/bin/2.1.226")).toBe("");
	});

	it("is not mistaken for an AI CLI, and does not become one either", () => {
		expect(isAiCli("2.1.226")).toBe(false);
		expect(isAiCli("claude")).toBe(true); // what the runner's fallback now reports instead
	});

	it("says the command could not be READ instead of naming a version", () => {
		const sentence = describeUnmetered({ driver: "terminal", target: "tmux:heartfull-tmux", activeCommand: "2.1.226" });
		expect(sentence).toContain("could not be read");
		expect(sentence).not.toContain("2.1.226");
	});

	it("with the fallback in place, the specific sentence finally fires", () => {
		const sentence = describeUnmetered({ driver: "terminal", target: "tmux:heartfull-tmux", activeCommand: "claude" });
		expect(sentence).toBe("Drove claude in tmux:heartfull-tmux — its token spend is NOT measured and is missing from your usage total.");
	});

	it("still distinguishes an unreadable pane from one running an ordinary program", () => {
		expect(normalizePaneCommand("node")).toBe("node");
		expect(describeUnmetered({ driver: "terminal", target: "tmux:x", activeCommand: "node" })).toContain("pane running node");
	});
});
