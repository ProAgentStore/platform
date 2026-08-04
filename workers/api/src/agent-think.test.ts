import { describe, expect, it } from "vitest";
import { toolBlurbFor, withPartialToolLog } from "./agent-think.js";
import type { AgentCapabilities } from "./lib/agent-capabilities.js";

describe("withPartialToolLog (#24 — surface committed side effects on a late failure)", () => {
	it("attaches the completed tool log to an Error and returns the same error", () => {
		const err = new Error("provider exploded mid-turn");
		const out = withPartialToolLog(err, ["✅ **create_task** done"]);
		expect(out).toBe(err);
		expect((err as { partialToolLog?: string[] }).partialToolLog).toEqual(["✅ **create_task** done"]);
	});

	it("no-ops when nothing succeeded (empty tool log)", () => {
		const err = new Error("failed on round 0");
		withPartialToolLog(err, []);
		expect((err as { partialToolLog?: string[] }).partialToolLog).toBeUndefined();
	});

	it("preserves the error's own type/status (creds/provider errors still propagate)", () => {
		const err = Object.assign(new Error("bad creds"), { status: 401 });
		const out = withPartialToolLog(err, ["✅ **insert_record** ok"]) as {
			status?: number;
			partialToolLog?: string[];
		};
		expect(out.status).toBe(401);
		expect(out.partialToolLog).toEqual(["✅ **insert_record** ok"]);
	});

	it("tolerates a non-object error without throwing", () => {
		expect(() => withPartialToolLog("string error", ["✅ x"])).not.toThrow();
		expect(withPartialToolLog("string error", ["✅ x"])).toBe("string error");
	});
});

describe("toolBlurbFor (declared tools must not be described as tools the agent lacks)", () => {
	const caps = (over: Partial<AgentCapabilities>): AgentCapabilities =>
		({ surfaces: [], runtime: null, workflow: null, ...over }) as AgentCapabilities;

	// The regression: Local Repo Chat declares tools and NO surface. It fell through to the
	// generic blurb, was told it could "search your knowledge", and concluded its repo tools
	// needed an index first — so it refused to read a repo it could already read.
	it("a declared-tools agent with no surface is never told it can search knowledge", () => {
		const blurb = toolBlurbFor(caps({ tools: ["repo_tree", "repo_read_file"] }));
		expect(blurb).not.toContain("search your knowledge");
		expect(blurb).not.toContain("collections");
		expect(blurb).toContain("exactly what you have");
	});

	it("tells a declared-tools agent not to invent a prerequisite setup step", () => {
		const blurb = toolBlurbFor(caps({ tools: ["repo_tree"] }));
		expect(blurb).toMatch(/indexing|ingestion/);
	});

	// A declared allowlist wins over the surface, since the allowlist is what actually gates.
	it("prefers the declared list over a surface that would describe different tools", () => {
		expect(toolBlurbFor(caps({ surfaces: ["repo"], tools: ["repo_tree"] }))).toContain("exactly what you have");
	});

	it("keeps the surface-derived blurbs for legacy agents that declare no tools", () => {
		expect(toolBlurbFor(caps({ surfaces: ["repo"] }))).toContain("indexed repositories");
		expect(toolBlurbFor(caps({ surfaces: ["coding"] }))).toContain("live terminal");
		expect(toolBlurbFor(caps({}))).toContain("search your knowledge");
		// An empty declared list is "declared nothing", not "declared" — must not win.
		expect(toolBlurbFor(caps({ tools: [] }))).toContain("search your knowledge");
	});
});
