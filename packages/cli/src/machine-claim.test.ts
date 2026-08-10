import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	claimCandidates,
	claimPromptSkipReason,
	describeCandidate,
	maybeClaimMachineNames,
	type NodeSummary,
	parseNodesResponse,
	parseSelection,
	relativeAge,
	renderCandidates,
	resolveClaimByName,
} from "./machine-claim.js";
import type { MachineIdentity } from "./machine.js";

const ID = "2f1c8a90-0e2b-4b6a-9a2b-3c4d5e6f7081";

// The identity lives in `~/.config/proagentstore/machine.json`. A unit test must never read or
// write the developer's home, so the file layer is stubbed and the pure helpers are the real ones.
const saved: MachineIdentity[] = [];
let stored: MachineIdentity = { id: ID, names: ["Mac"], declined: [] };
vi.mock("./machine.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./machine.js")>();
	return {
		...actual,
		loadMachineIdentity: () => stored,
		machineFilePath: () => "/tmp/test/machine.json",
		saveMachineIdentity: (identity: MachineIdentity) => {
			saved.push(identity);
			return true;
		},
	};
});

const node = (over: Partial<NodeSummary> & { node: string }): NodeSummary => ({
	machineId: null,
	lastSeenAt: "2026-08-07 09:20:00",
	connected: false,
	agentCount: 1,
	...over,
});

const identity = (over: Partial<MachineIdentity> = {}): MachineIdentity => ({
	id: ID,
	names: ["Mac"],
	declined: [],
	...over,
});

describe("claimPromptSkipReason", () => {
	// `pags up` is the entry point for EVERY runtime agent. Each of these is a machine that has no
	// human at it, and a prompt on one of them takes the whole runtime offline until someone
	// notices. The gate is pure so that fact is checkable without a terminal.
	it("refuses to prompt on a machine with nobody at it", () => {
		expect(claimPromptSkipReason({ headless: true, isTTY: true })).toBe("headless");
		expect(claimPromptSkipReason({ isTTY: undefined })).toBe("no-tty");
		expect(claimPromptSkipReason({ isTTY: false })).toBe("no-tty");
		expect(claimPromptSkipReason({ isTTY: true, ci: true })).toBe("ci");
		expect(claimPromptSkipReason({ isTTY: true, suppressed: true })).toBe("suppressed");
	});

	it("prompts only on an interactive terminal", () => {
		expect(claimPromptSkipReason({ isTTY: true })).toBeNull();
	});
});

describe("claimCandidates", () => {
	// The three refusals are the whole safety argument (#460): nothing here infers that two names
	// are one machine, it only ever removes names that would be unsafe to offer.
	it("never offers a name another machine has already proven is its own", () => {
		const nodes = [node({ node: "Sergeys-Mac-mini.local", machineId: "other-machine-id" })];
		expect(claimCandidates(nodes, identity())).toEqual([]);
	});

	it("never offers a name whose runner is connected right now", () => {
		// This machine has not registered yet when the question is asked, so a live socket under
		// some other name is evidence of a DIFFERENT machine — the most expensive wrong answer.
		const nodes = [node({ node: "Sergeys-Mac-mini.local", connected: true })];
		expect(claimCandidates(nodes, identity())).toEqual([]);
	});

	it("never offers a name this machine already answers to, or one already declined", () => {
		const nodes = [node({ node: "Mac" }), node({ node: "old-host" })];
		expect(claimCandidates(nodes, identity({ names: ["Mac"], declined: ["old-host"] }))).toEqual([]);
	});

	it("offers the stranded names, freshest first", () => {
		const nodes = [
			node({ node: "RLs-MacBook-Air", lastSeenAt: "2026-07-16 22:28:00", agentCount: 2 }),
			node({ node: "Mac", connected: true }),
			node({ node: "RLs-MacBook-Air.local", lastSeenAt: "2026-08-07 09:20:00", agentCount: 16 }),
		];
		expect(claimCandidates(nodes, identity()).map((c) => c.node)).toEqual([
			"RLs-MacBook-Air.local",
			"RLs-MacBook-Air",
		]);
	});

	it("collapses a name reported twice", () => {
		const nodes = [node({ node: "old-host" }), node({ node: "old-host" })];
		expect(claimCandidates(nodes, identity())).toHaveLength(1);
	});
});

describe("parseSelection", () => {
	it("treats a bare Enter as skip, so the prompt can be dismissed unread", () => {
		for (const input of ["", "   ", "n", "no", "skip", "none"]) {
			expect(parseSelection(input, 2)).toEqual({ kind: "skip" });
		}
	});

	it("reads numbers in either separator, de-duplicated", () => {
		expect(parseSelection("1,2", 2)).toEqual({ kind: "pick", indices: [0, 1] });
		expect(parseSelection("2 1 2", 2)).toEqual({ kind: "pick", indices: [1, 0] });
		expect(parseSelection("all", 3)).toEqual({ kind: "pick", indices: [0, 1, 2] });
	});

	// Silently reading unparseable input as "no" would record a decline the user never made, and
	// a decline is remembered — so the name would never be offered again.
	it("refuses input it cannot read rather than calling it a decline", () => {
		expect(parseSelection("1;2", 2).kind).toBe("invalid");
		expect(parseSelection("7", 2).kind).toBe("invalid");
		expect(parseSelection("0", 2).kind).toBe("invalid");
	});
});

describe("parseNodesResponse", () => {
	it("reads the fields the prompt needs off /v1/terminals/nodes", () => {
		expect(
			parseNodesResponse({
				nodes: [
					{ node: "Mac", machineId: ID, aka: ["x"], lastSeenAt: "2026-08-07 09:20:00", connected: true, instances: [{}, {}] },
					{ node: " old-host ", machineId: null, instances: [] },
					{ node: "" },
					{ nope: 1 },
				],
			}),
		).toEqual([
			{ node: "Mac", machineId: ID, lastSeenAt: "2026-08-07 09:20:00", connected: true, agentCount: 2 },
			{ node: "old-host", machineId: null, lastSeenAt: null, connected: false, agentCount: 0 },
		]);
	});

	it("reads a malformed body as no candidates rather than throwing on a startup path", () => {
		for (const body of [null, {}, { nodes: "x" }, 42]) expect(parseNodesResponse(body)).toEqual([]);
	});
});

describe("relativeAge / describeCandidate", () => {
	const now = Date.parse("2026-08-08T12:00:00Z");
	it("is coarse on purpose — recognition, not precision", () => {
		expect(relativeAge("2026-08-08 11:30:00", now)).toBe("last seen 30 min ago");
		expect(relativeAge("2026-08-08 02:00:00", now)).toBe("last seen 10 hours ago");
		expect(relativeAge("2026-08-01 12:00:00", now)).toBe("last seen 7 days ago");
		expect(relativeAge("2026-05-08 12:00:00", now)).toBe("last seen 3 months ago");
		expect(relativeAge(null, now)).toBe("last seen unknown");
	});

	it("names the agent count, which is how a user recognises their own laptop", () => {
		expect(describeCandidate(node({ node: "x", lastSeenAt: "2026-08-01 12:00:00", agentCount: 16 }), now))
			.toBe("last seen 7 days ago · 16 agents");
		expect(describeCandidate(node({ node: "x", lastSeenAt: "2026-08-01 12:00:00", agentCount: 1 }), now))
			.toBe("last seen 7 days ago · 1 agent");
	});
});

describe("renderCandidates", () => {
	it("states the consequence and how to undo a wrong claim (#467)", () => {
		const text = renderCandidates([node({ node: "old-host", agentCount: 16 })], Date.parse("2026-08-08T12:00:00Z")).join("\n");
		expect(text).toContain("1) old-host");
		expect(text).toContain("merges its agents, pins and sessions onto this machine");
		expect(text).toContain("unclaim");
	});
});

describe("resolveClaimByName", () => {
	const nodes = [
		node({ node: "old-host" }),
		node({ node: "someone-else", machineId: "other-id" }),
		node({ node: "live-box", connected: true }),
	];

	it("claims an unclaimed, offline name", () => {
		expect(resolveClaimByName(["old-host"], nodes, identity()).claim).toEqual(["old-host"]);
	});

	// A claim that reports success while stamping nothing is the invisible no-op this whole class
	// of defect started as, so every refusal is named.
	it("refuses, loudly, everything the prompt would refuse", () => {
		const { claim, problems } = resolveClaimByName(["someone-else", "live-box", "nope", "Mac"], nodes, identity());
		expect(claim).toEqual([]);
		expect(problems).toHaveLength(4);
		expect(problems.join("\n")).toContain("already claimed by another machine");
		expect(problems.join("\n")).toContain("a runner is connected there right now");
		expect(problems.join("\n")).toContain("no machine on this account is registered");
		expect(problems.join("\n")).toContain("already claims that name");
	});

	// Unlike the prompt, an explicit name overrides an earlier decline: typing it IS a later answer.
	it("claims a previously declined name when the user names it explicitly", () => {
		expect(resolveClaimByName(["old-host"], nodes, identity({ declined: ["old-host"] })).claim).toEqual(["old-host"]);
	});
});

describe("maybeClaimMachineNames — the startup path", () => {
	beforeEach(() => {
		saved.length = 0;
		stored = { id: ID, names: ["Mac"], declined: [] };
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** A fetch that fails the test if it is ever called — "no delay" has to mean "no request". */
	const forbiddenFetch = vi.fn(async () => {
		throw new Error("fetch must not be called on a gated path");
	}) as unknown as typeof fetch;

	const forbiddenAsk = async () => {
		throw new Error("ask must not be called on a gated path");
	};

	// THE regression guard named in #460: `pags up` must come up on a headless box, over SSH, in
	// CI and with stdin closed. Not merely "no prompt" — no network call either, because a slow
	// API on a machine with no keyboard is the same outage with a different cause.
	it("makes no prompt and no request when stdin is closed", async () => {
		const out = await maybeClaimMachineNames({
			token: "t",
			apiBase: "https://api.example",
			isTTY: undefined,
			env: {},
			fetchImpl: forbiddenFetch,
			ask: forbiddenAsk,
		});
		expect(out).toEqual({ prompted: false, reason: "no-tty" });
		expect(saved).toEqual([]);
	});

	it("makes no prompt and no request under --headless, CI, or PAGS_NO_PROMPT", async () => {
		const base = { token: "t", apiBase: "https://api.example", isTTY: true, fetchImpl: forbiddenFetch, ask: forbiddenAsk };
		expect(await maybeClaimMachineNames({ ...base, headless: true, env: {} }))
			.toEqual({ prompted: false, reason: "headless" });
		expect(await maybeClaimMachineNames({ ...base, env: { CI: "true" } }))
			.toEqual({ prompted: false, reason: "ci" });
		expect(await maybeClaimMachineNames({ ...base, env: { PAGS_NO_PROMPT: "1" } }))
			.toEqual({ prompted: false, reason: "suppressed" });
	});

	it("says nothing when the machine could not persist an id", async () => {
		stored = { id: "", names: [], declined: [] };
		const out = await maybeClaimMachineNames({
			token: "t",
			apiBase: "https://api.example",
			isTTY: true,
			env: {},
			fetchImpl: forbiddenFetch,
			ask: forbiddenAsk,
		});
		expect(out).toEqual({ prompted: false, reason: "no-identity" });
	});

	const respond = (nodes: unknown[]) =>
		(async () => new Response(JSON.stringify({ nodes }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

	it("starts the runner anyway when the API is down", async () => {
		const failing = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		const out = await maybeClaimMachineNames({ token: "t", apiBase: "https://api.example", isTTY: true, env: {}, fetchImpl: failing, ask: forbiddenAsk });
		expect(out).toEqual({ prompted: false, reason: "unavailable" });
	});

	it("does not prompt when there is nothing unclaimed to offer", async () => {
		const out = await maybeClaimMachineNames({
			token: "t",
			apiBase: "https://api.example",
			isTTY: true,
			env: {},
			fetchImpl: respond([{ node: "Mac", machineId: null, instances: [] }]),
			ask: forbiddenAsk,
		});
		expect(out).toEqual({ prompted: false, reason: "nothing-unclaimed" });
	});

	it("claims only what was selected, and declines the rest in the same write", async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const out = await maybeClaimMachineNames({
			token: "t",
			apiBase: "https://api.example",
			isTTY: true,
			env: {},
			fetchImpl: respond([
				{ node: "RLs-MacBook-Air.local", machineId: null, lastSeenAt: "2026-08-07 09:20:00", instances: [{}] },
				{ node: "RLs-MacBook-Air", machineId: null, lastSeenAt: "2026-07-16 22:28:00", instances: [{}] },
			]),
			ask: async () => "1",
		});
		expect(out).toEqual({ prompted: true, reason: "claimed", claimed: ["RLs-MacBook-Air.local"], declined: ["RLs-MacBook-Air"] });
		expect(saved).toHaveLength(1);
		expect(saved[0].names).toEqual(["Mac", "RLs-MacBook-Air.local"]);
		expect(saved[0].declined).toEqual(["RLs-MacBook-Air"]);
	});

	// "Offer it once, not forever": a user who genuinely owns three machines must not be
	// interrogated at every launch.
	it("remembers a skip so the same names are never offered again", async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const nodes = [{ node: "old-host", machineId: null, lastSeenAt: "2026-07-16 22:28:00", instances: [{}] }];
		const out = await maybeClaimMachineNames({ token: "t", apiBase: "https://api.example", isTTY: true, env: {}, fetchImpl: respond(nodes), ask: async () => "" });
		expect(out).toEqual({ prompted: true, reason: "declined", claimed: [], declined: ["old-host"] });
		expect(saved[0].names).toEqual(["Mac"]);
		expect(saved[0].declined).toEqual(["old-host"]);

		stored = saved[0];
		saved.length = 0;
		const again = await maybeClaimMachineNames({ token: "t", apiBase: "https://api.example", isTTY: true, env: {}, fetchImpl: respond(nodes), ask: forbiddenAsk });
		expect(again).toEqual({ prompted: false, reason: "nothing-unclaimed" });
		expect(saved).toEqual([]);
	});

	// An interrupted question is not an answer. Recording it as a decline would burn the offer on
	// a Ctrl+C, and a decline is remembered.
	it("records nothing when the terminal goes away mid-question", async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const out = await maybeClaimMachineNames({
			token: "t",
			apiBase: "https://api.example",
			isTTY: true,
			env: {},
			fetchImpl: respond([{ node: "old-host", machineId: null, instances: [{}] }]),
			ask: async () => {
				throw new Error("stdin closed");
			},
		});
		expect(out).toEqual({ prompted: false, reason: "no-tty" });
		expect(saved).toEqual([]);
	});

	// Two unreadable answers is a fumbled syntax, not a decline: recording one would burn the
	// offer permanently on a typo, and the offer IS the remedy. Bounded, so it is not a hang.
	it("gives up after two unreadable answers without recording anything", async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const ask = vi.fn(async () => "!!!");
		const out = await maybeClaimMachineNames({
			token: "t",
			apiBase: "https://api.example",
			isTTY: true,
			env: {},
			fetchImpl: respond([{ node: "old-host", machineId: null, instances: [{}] }]),
			ask,
		});
		expect(ask).toHaveBeenCalledTimes(2);
		expect(out).toEqual({ prompted: false, reason: "unanswered" });
		expect(saved).toEqual([]);
	});
});
