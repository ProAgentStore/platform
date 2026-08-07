import { describe, expect, it } from "vitest";
import {
	classifyEngineMetering,
	describeUnmetered,
	emptyUnmeteredSummary,
	isAiCli,
	noteUnmeteredDrive,
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
	it("meters Claude Code only when the Pilot drives it as a child process", () => {
		expect(classifyEngineMetering("headless", "claude").metered).toBe(true);
	});

	it("does NOT meter Claude Code through a terminal — the driver decides, not the engine", () => {
		// The bug in one line: same binary, same repo, same spend; a pane just cannot report it.
		const v = classifyEngineMetering("terminal", "claude");
		expect(v.metered).toBe(false);
		expect(v.reason).toContain("claude");
	});

	it("does not meter engines with no structured turn event under either driver", () => {
		expect(classifyEngineMetering("headless", "codex").metered).toBe(false);
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
		const env = {
			DB: {
				prepare() {
					throw new Error("d1 down");
				},
			},
		} as unknown as Env;
		await expect(noteUnmeteredDrive(env, { userId: "u1", instanceId: "i1" }, { driver: "terminal", target: "t" })).resolves.toBeUndefined();
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
