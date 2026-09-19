/**
 * The Instances tab's sort and agent filter (#815).
 *
 * Same split as `instanceSearch.test.ts`: which rows, in which order, is a value and is tested as
 * one here; the controls are a component and belong to `Dashboard.instances.test.ts` (wiring) and
 * Playwright (the page).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceActivity } from "./instanceActivity";
import { INSTANCE_SORT_LABEL, INSTANCE_SORTS, agentLabel, agentOptions, listInstances, parseSort, rememberSort, rememberedSort } from "./instanceList.js";
import type { Instance } from "./types";

function inst(over: Partial<Instance> & { id: string }): Instance {
	return {
		agent_id: "agent-1",
		slug: "an-instance",
		name: "An Instance",
		status: "active",
		created_at: "2026-01-01T00:00:00Z",
		...over,
	};
}

// In the SERVER's order (most recently used first), which is deliberately not alphabetical.
const PWS = inst({ id: "i1", agent_id: "coder", name: "pws platform", slug: "coder", agentName: "Repo Coder" });
const JOBS = inst({ id: "i2", agent_id: "jobs", name: "Job Application Assistant", slug: "job-application-assistant", description: "Applies with a coder's care" });
const FAS = inst({ id: "i3", agent_id: "coder", name: "FAS platform", slug: "coder", agentName: "Repo Coder" });
const CODER = inst({ id: "i4", agent_id: "coder", name: "Repo Coder", slug: "coder" });
const LIST = [PWS, JOBS, FAS, CODER];

const ALL = { query: "", sort: "recent", agentId: "" } as const;
const ids = (rows: Instance[]) => rows.map((i) => i.id);

describe("parseSort", () => {
	it("accepts every sort on offer, and every sort has a label", () => {
		for (const s of INSTANCE_SORTS) {
			expect(parseSort(s)).toBe(s);
			expect(INSTANCE_SORT_LABEL[s]).toBeTruthy();
		}
	});

	it("falls back to the default for anything else — a stale key must not select nothing", () => {
		// "status" was in this list until #815 slice 4 made it a real sort. A value leaving the
		// rejected set is the one direction this test cannot notice on its own, hence the note.
		expect(parseSort("health")).toBe("recent");
		expect(parseSort(null)).toBe("recent");
		expect(parseSort(undefined)).toBe("recent");
	});
});

describe("the remembered sort", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("round-trips through storage", () => {
		const store = new Map<string, string>();
		vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
		expect(rememberedSort()).toBe("recent");
		rememberSort("name");
		expect(rememberedSort()).toBe("name");
	});

	it("validates what it reads back", () => {
		vi.stubGlobal("localStorage", { getItem: () => "by-vibes", setItem: () => {} });
		expect(rememberedSort()).toBe("recent");
	});

	it("survives storage that throws (private mode) in both directions", () => {
		const boom = () => {
			throw new Error("denied");
		};
		vi.stubGlobal("localStorage", { getItem: boom, setItem: boom });
		expect(rememberedSort()).toBe("recent");
		expect(() => rememberSort("name")).not.toThrow();
	});
});

describe("agentLabel", () => {
	it("is the agent's name whether or not the instance was renamed", () => {
		expect(agentLabel(FAS)).toBe("Repo Coder");
		expect(agentLabel(CODER)).toBe("Repo Coder");
	});
});

describe("agentOptions", () => {
	it("offers one entry per agent, A–Z, counting its instances", () => {
		expect(agentOptions(LIST)).toEqual([
			{ agentId: "jobs", label: "Job Application Assistant", count: 1 },
			{ agentId: "coder", label: "Repo Coder", count: 3 },
		]);
	});

	it("labels a group by the AGENT even when the first row seen is a renamed one", () => {
		// PWS comes first and its `name` is "pws platform". Labelling the group from `name` would
		// offer "pws platform (3)" — a filter named after one of the things it contains.
		expect(agentOptions([PWS, CODER])[0].label).toBe("Repo Coder");
	});

	it("is empty for an empty list", () => {
		expect(agentOptions([])).toEqual([]);
	});
});

describe("listInstances", () => {
	it("returns the SAME array when nothing narrows and the order is the server's", () => {
		expect(listInstances(LIST, ALL)).toBe(LIST);
	});

	it("'recent' keeps the server's order — it is the server's answer, not ours to restyle", () => {
		expect(ids(listInstances(LIST, { ...ALL, agentId: "coder" }))).toEqual(["i1", "i3", "i4"]);
	});

	it("sorts by name, ignoring case", () => {
		// "FAS…" < "Job…" < "pws…" < "Repo…" only if case is ignored; a raw compare puts "pws" last.
		expect(ids(listInstances(LIST, { ...ALL, sort: "name" }))).toEqual(["i3", "i2", "i1", "i4"]);
	});

	it("sorts numerically, so the auto-named 'Agent 10' follows 'Agent 9'", () => {
		const rows = [inst({ id: "a", name: "Coder 10" }), inst({ id: "b", name: "Coder 9" }), inst({ id: "c", name: "Coder 2" })];
		expect(ids(listInstances(rows, { ...ALL, sort: "name" }))).toEqual(["c", "b", "a"]);
	});

	it("breaks a name tie by id, so same-named siblings hold their places", () => {
		const rows = [inst({ id: "z", name: "Repo Coder" }), inst({ id: "a", name: "Repo Coder" })];
		expect(ids(listInstances(rows, { ...ALL, sort: "name" }))).toEqual(["a", "z"]);
	});

	it("never mutates the input — it is React state, and 'recent' needs the server's order back", () => {
		const before = [...LIST];
		listInstances(LIST, { ...ALL, sort: "name" });
		expect(LIST).toEqual(before);
	});

	it("filters to one agent", () => {
		expect(ids(listInstances(LIST, { ...ALL, agentId: "jobs" }))).toEqual(["i2"]);
	});

	it("searches through lib/instanceSearch — same rules, not a second copy of them", () => {
		// JOBS's DESCRIPTION contains "coder", and instanceSearch excludes description on purpose —
		// so JOBS appearing here would mean the matching had been re-implemented, loosely.
		expect(ids(listInstances(LIST, { ...ALL, query: "coder" }))).toEqual(["i1", "i3", "i4"]);
		// "repo coder" is in neither the display name nor the slug of a renamed instance.
		expect(ids(listInstances(LIST, { ...ALL, query: "repo coder" }))).toEqual(["i1", "i3", "i4"]);
	});

	it("composes search, agent and sort", () => {
		expect(ids(listInstances(LIST, { query: "platform", sort: "name", agentId: "coder" }))).toEqual(["i3", "i1"]);
	});

	it("returns empty when the search and the agent filter disagree — the caller owns that state", () => {
		expect(listInstances(LIST, { ...ALL, query: "fas", agentId: "jobs" })).toEqual([]);
	});
});

describe("listInstances with activity (#815 slice 4)", () => {
	const map = new Map<string, InstanceActivity>([
		["a", { instanceId: "a", health: "idle", queueDepth: 0, lastOutcome: null }],
		["b", { instanceId: "b", health: "stalled", queueDepth: 0, lastOutcome: null }],
		["c", { instanceId: "c", health: "working", queueDepth: 0, lastOutcome: null }],
	]);
	const rows = [inst({ id: "a", name: "Alpha" }), inst({ id: "b", name: "Bravo" }), inst({ id: "c", name: "Charlie" })];

	it("filters by status", () => {
		expect(listInstances(rows, { query: "", sort: "name", agentId: "", health: "stalled", activity: map }).map((r) => r.id)).toEqual(["b"]);
	});

	it("treats an instance the response OMITTED as idle, not as unmatched", () => {
		const rowsPlus = [...rows, inst({ id: "d", name: "Delta" })];
		expect(listInstances(rowsPlus, { query: "", sort: "name", agentId: "", health: "idle", activity: map }).map((r) => r.id)).toEqual(["a", "d"]);
	});

	it("sorts by status with whatever needs the owner first", () => {
		expect(listInstances(rows, { query: "", sort: "status", agentId: "", activity: map }).map((r) => r.id)).toEqual(["b", "c", "a"]);
	});

	it("leaves the server's order alone until the poll has landed", () => {
		// Before the first response every instance reads idle, and re-sorting on that would shuffle
		// the list for no reason and then shuffle it back.
		expect(listInstances(rows, { query: "", sort: "recent", agentId: "", activity: new Map() })).toBe(rows);
	});

	it("re-sorts `recent` on the CORRECTED definition once activity is known", () => {
		const now = Date.now();
		const active = new Map<string, InstanceActivity>([
			["a", { instanceId: "a", health: "idle", queueDepth: 0, lastOutcome: null }],
			["c", { instanceId: "c", health: "working", queueDepth: 0, lastOutcome: { runId: "r", status: "running", stopReason: null, finishedAt: null, startedAt: now - 60_000, lastAliveAt: now } }],
		]);
		// Charlie's Pilot is working right now; nobody has touched Alpha. `last_activity_at` alone
		// would not move Charlie — this is the whole reason the label said "Recently used".
		expect(listInstances(rows, { query: "", sort: "recent", agentId: "", activity: active })[0].id).toBe("c");
	});
});
