import { describe, expect, it } from "vitest";
import {
	addressFor,
	captureArgs,
	createArgs,
	createdTargetKey,
	killArgs,
	parseTargets,
	resolveTerminalAccess,
	resolveTerminalWrites,
	runArgs,
	sendKeysArgs,
	TERMINAL_FAMILY,
	TERMINAL_TOOL_FAMILIES,
	terminalFamilyToolNames,
	TMUX_FAMILY,
} from "./terminalTools.js";

/**
 * #409, stated as the thing it is: a SHAPE change that a rename would have got wrong four ways.
 *
 * Each `describe` below is one of the four differences the ticket measured, plus the resolution
 * rule that decides which family is in play. The tmux-list case is the one worth reading first —
 * a name-only swap type-checks, compiles, ships, and yields an empty tab.
 */

const ALL = (...names: string[]) => new Set(names);
const TERMINAL_ALL = ALL(...terminalFamilyToolNames(TERMINAL_FAMILY));
const TMUX_ALL = ALL(...terminalFamilyToolNames(TMUX_FAMILY));

describe("resolveTerminalAccess", () => {
	it("waits for the policy rather than guessing at it", () => {
		expect(resolveTerminalAccess(null)).toEqual({ state: "loading" });
	});

	it("picks the family the agent actually declares", () => {
		expect(resolveTerminalAccess(TMUX_ALL)).toEqual({ state: "ready", family: TMUX_FAMILY, canCapture: true });
		expect(resolveTerminalAccess(TERMINAL_ALL)).toEqual({ state: "ready", family: TERMINAL_FAMILY, canCapture: true });
	});

	it("keeps the generic family first, because three of the four Operators still use it", () => {
		// `terminal-operator`, `kitty-operator` and `iterm-operator` share this one tab with the agent
		// #403 changed. Fixing one of four by breaking three is the regression that is always one
		// commit away here.
		const both = ALL(...TERMINAL_ALL, ...TMUX_ALL);
		expect(resolveTerminalAccess(both)).toMatchObject({ family: TERMINAL_FAMILY });
	});

	it("reports unsupported — with the tools it needs — when the agent declares neither", () => {
		// The live shape of the bug: `tools[]` is an exclusive allowlist, so an agent that declares
		// six `tmux_*` tools has no `terminal_*` at all, and vice versa.
		const s = resolveTerminalAccess(ALL("github_list_issues", "web_search"));
		expect(s).toEqual({ state: "unsupported", needs: ["terminal_list_targets", "tmux_list_sessions"] });
	});

	it("treats listing and capturing as two verdicts, not one", () => {
		const s = resolveTerminalAccess(ALL("tmux_list_sessions"));
		expect(s).toEqual({ state: "ready", family: TMUX_FAMILY, canCapture: false });
	});
});

describe("resolveTerminalWrites — `1f3ca00`'s per-tool gate, not one canWrite", () => {
	it("answers per tool", () => {
		const w = resolveTerminalWrites(TMUX_FAMILY, ALL("tmux_list_sessions", "tmux_run_command", "tmux_kill_session"));
		expect(w).toEqual({ run: true, sendKeys: false, create: false, kill: true, any: true });
	});

	it("grants nothing when there is no family or no policy yet", () => {
		expect(resolveTerminalWrites(null, TMUX_ALL).any).toBe(false);
		expect(resolveTerminalWrites(TMUX_FAMILY, null).any).toBe(false);
	});

	it("does not let one family's grant unlock the other's controls", () => {
		// The alias trap the ticket rejects: the two connectors have different argument shapes AND
		// different consent keys, so a `terminal` grant says nothing about what tmux may do.
		expect(resolveTerminalWrites(TMUX_FAMILY, TERMINAL_ALL).any).toBe(false);
	});
});

describe("parseTargets — the trap a rename walks into", () => {
	const TMUX_ROWS = JSON.stringify([
		{ name: "main", windows: 3, attached: true, activeCommand: "pnpm test", activeWindow: "editor", created: "1754600000" },
		{ name: "build", windows: 1, attached: false, activeCommand: "vite", activeWindow: "", created: "1754600001" },
	]);

	it("THE TRAP: a tmux row has no `backend` and no `id`, and must not be dropped for it", () => {
		// `/tmux/list` returns `{name, windows, attached, activeCommand, activeWindow, created}`
		// (browser-runner/src/coding/tmux.ts). The old parser required `backend` AND `id`, so swapping
		// only the tool NAME yields an empty list — a tab that looks like it works on a machine with
		// nothing running, which is a worse failure than the 403 it replaced.
		const rows = parseTargets(TMUX_FAMILY, TMUX_ROWS);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ backend: "tmux", id: "main", name: "main", windows: 3, attached: true, activeCommand: "pnpm test" });
	});

	it("gives the tmux rows their backend in the console, so no runner upgrade is needed", () => {
		// `pags up` is an installed npm package on someone else's machine. A fix that needs a new
		// runner does not reach the person who has the bug until they upgrade.
		expect(parseTargets(TMUX_FAMILY, TMUX_ROWS).every((r) => r.backend === "tmux")).toBe(true);
	});

	it("still reads the generic connector's rows exactly as before", () => {
		const rows = parseTargets(TERMINAL_FAMILY, JSON.stringify([
			{ backend: "tmux", id: "main", name: "main" },
			{ backend: "kitty", id: "7", name: "scratch" },
			{ backend: "nope", id: "x", name: "x" },
			{ backend: "tmux", name: "no id" },
		]));
		expect(rows.map((r) => r.id)).toEqual(["main", "7"]);
	});

	it("survives junk instead of throwing it at the render", () => {
		for (const bad of [undefined, "", "not json", "{}", '[1,"two",null]']) {
			expect(parseTargets(TMUX_FAMILY, bad)).toEqual([]);
		}
	});

	it("drops a nameless tmux row rather than inventing an empty session", () => {
		expect(parseTargets(TMUX_FAMILY, JSON.stringify([{ windows: 2 }]))).toEqual([]);
	});
});

describe("addressing — `target: \"tmux:main\"` vs `session: \"main\"`", () => {
	it("strips the backend prefix for tmux and keeps it for the generic connector", () => {
		expect(addressFor(TMUX_FAMILY, "tmux:main")).toBe("main");
		expect(addressFor(TERMINAL_FAMILY, "tmux:main")).toBe("tmux:main");
	});

	it("splits on the FIRST colon — a tmux session name may contain one", () => {
		expect(addressFor(TMUX_FAMILY, "tmux:a:b")).toBe("a:b");
	});

	it("builds capture / run / kill in each family's own shape", () => {
		expect(captureArgs(TMUX_FAMILY, "tmux:main", 500)).toEqual({ session: "main", lines: 500 });
		expect(captureArgs(TERMINAL_FAMILY, "kitty:7", 500)).toEqual({ target: "kitty:7", lines: 500 });
		expect(runArgs(TMUX_FAMILY, "tmux:main", "pnpm test")).toEqual({ session: "main", command: "pnpm test" });
		expect(runArgs(TERMINAL_FAMILY, "tmux:main", "pnpm test")).toEqual({ target: "tmux:main", command: "pnpm test" });
		expect(killArgs(TMUX_FAMILY, "tmux:main")).toEqual({ session: "main" });
		expect(killArgs(TERMINAL_FAMILY, "tmux:main")).toEqual({ target: "tmux:main" });
	});
});

describe("send-keys — an array on one side, a comma-separated string on the other", () => {
	it("sends tmux a string it will split, and the generic connector an array", () => {
		// `tmux_send_keys` reads `keys` as `String(input.keys ?? "").split(",")`. Handing it an array
		// works for ONE key by coincidence of JS stringification and is a coin toss for two.
		expect(sendKeysArgs(TMUX_FAMILY, "tmux:main", "y", ["Enter", "C-c"])).toEqual({ session: "main", text: "y", keys: "Enter,C-c" });
		expect(sendKeysArgs(TERMINAL_FAMILY, "tmux:main", "y", ["Enter", "C-c"])).toEqual({ target: "tmux:main", text: "y", keys: ["Enter", "C-c"] });
	});

	it("omits empty text rather than sending an empty string", () => {
		expect(sendKeysArgs(TMUX_FAMILY, "tmux:main", "", ["Enter"]).text).toBeUndefined();
	});
});

describe("create — `{backend, name}` vs `{session}`", () => {
	it("names the session for tmux and the backend for the generic connector", () => {
		expect(createArgs(TMUX_FAMILY, { backend: "tmux", name: "build", workDir: "~/dev", command: "claude" }))
			.toEqual({ session: "build", workDir: "~/dev", command: "claude" });
		expect(createArgs(TERMINAL_FAMILY, { backend: "kitty", name: "build", workDir: "", command: "" }))
			.toEqual({ backend: "kitty", name: "build", workDir: undefined, command: undefined });
	});

	it("never sends tmux a `backend` — the tool's schema has no such property", () => {
		expect(createArgs(TMUX_FAMILY, { backend: "kitty", name: "build" })).not.toHaveProperty("backend");
	});

	it("selects what it created, from JSON or from an English sentence", () => {
		// `terminal_new_target` returns the target as JSON; `tmux_new_session` returns prose.
		expect(createdTargetKey(TERMINAL_FAMILY, JSON.stringify({ target: { backend: "kitty", id: "9" } }), "kitty", "build")).toBe("kitty:9");
		expect(createdTargetKey(TERMINAL_FAMILY, JSON.stringify({ backend: "tmux", id: "build" }), "tmux", "build")).toBe("tmux:build");
		expect(createdTargetKey(TMUX_FAMILY, 'Created tmux session "build".', "tmux", "build")).toBe("tmux:build");
		expect(createdTargetKey(TERMINAL_FAMILY, "not json", "tmux", "build")).toBe("tmux:build");
	});
});

describe("the families themselves", () => {
	it("declare six distinct tools each, sharing none", () => {
		const terminal = terminalFamilyToolNames(TERMINAL_FAMILY);
		const tmux = terminalFamilyToolNames(TMUX_FAMILY);
		expect(new Set(terminal).size).toBe(6);
		expect(new Set(tmux).size).toBe(6);
		expect(terminal.filter((n) => tmux.includes(n))).toEqual([]);
	});

	it("keep the backend vocabulary honest — the backend-exclusive family offers one", () => {
		// The create form's picker is rendered from this. Offering kitty on an agent whose tools
		// cannot reach it is a control that only ever produces a refusal.
		expect(TMUX_FAMILY.backends).toEqual(["tmux"]);
		expect(TERMINAL_FAMILY.backends).toEqual(["tmux", "kitty", "iterm2"]);
	});

	it("name the connector their write-consent row is keyed by", () => {
		for (const f of TERMINAL_TOOL_FAMILIES) {
			expect(f.connector, `${f.id} must key consent by its own connector`).toBe(f.id);
			expect(terminalFamilyToolNames(f).every((n) => n.startsWith(`${f.id}_`))).toBe(true);
		}
	});
});
