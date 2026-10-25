/**
 * #1212 — minutes-aware routing, executed: read the org's usage, write PAGS_RUNNER from selectRunnerLabel, flip back on reset.
 * Against a simulated GitHub that holds each repo's variable, so a sequence of syncs shows the route moving and moving back.
 */
import { describe, expect, it } from "vitest";
import { actionsMinutesUsed, INCLUDED_MINUTES_BY_PLAN, minuteMultiplier, readOrgMinutes, type RouteFlip, type RouteRepo, type RouteSyncDeps, syncRepoRoutes } from "./runner-routing-sync.js";

const NODE = "Sergeys-Mac-mini.local";
const LABELS = JSON.stringify(["self-hosted", "pags-sergeys-mac-mini-local"]);
const REPO = "proappstore-online/interns";

interface Sim extends RouteSyncDeps {
	variables: Map<string, string>;
	flips: RouteFlip[];
	calls: Array<{ method: string; url: string }>;
	usage: { items: unknown[] | null; status: number };
	plan: string | null;
	/** Status to answer variable WRITES with. */
	writeStatus: number;
	noApp: boolean;
}

function sim(over: { plan?: string | null; writeStatus?: number; noApp?: boolean; used?: Array<{ sku: string; quantity: number }>; usageStatus?: number } = {}): Sim {
	const s: Sim = {
		variables: new Map(),
		flips: [],
		calls: [],
		usage: { items: (over.used ?? []).map((u) => ({ product: "Actions", unitType: "Minutes", ...u })), status: over.usageStatus ?? 200 },
		plan: over.plan === undefined ? "team" : over.plan,
		writeStatus: over.writeStatus ?? 200,
		noApp: over.noApp ?? false,
		installationToken: async () => (s.noApp ? null : "ghs_app"),
		onFlip: async (f) => void s.flips.push(f),
		fetch: async (url, init) => {
			const method = init?.method ?? "GET";
			s.calls.push({ method, url });
			const repoVar = /repos\/([^/]+\/[^/]+)\/actions\/variables(?:\/PAGS_RUNNER)?$/.exec(url);
			if (/\/orgs\/[^/]+$/.test(url)) return Response.json(s.plan ? { plan: { name: s.plan } } : {});
			if (url.includes("/settings/billing/usage")) return s.usage.status === 200 ? Response.json({ usageItems: s.usage.items }) : new Response("{}", { status: s.usage.status });
			if (repoVar) {
				const repo = repoVar[1];
				if (method === "GET") return s.variables.has(repo) ? Response.json({ name: "PAGS_RUNNER", value: s.variables.get(repo) }) : new Response("{}", { status: 404 });
				if (s.writeStatus !== 200) return new Response("{}", { status: s.writeStatus });
				if (method === "DELETE") {
					s.variables.delete(repo);
					return new Response(null, { status: 204 });
				}
				const body = JSON.parse(String(init?.body)) as { value: string };
				s.variables.set(repo, body.value);
				return new Response(null, { status: method === "POST" ? 201 : 204 });
			}
			return new Response("{}", { status: 404 });
		},
	};
	return s;
}

const repo = (over: Partial<RouteRepo> = {}): RouteRepo => ({ repo: REPO, visibility: "private", pinnedNode: NODE, ...over });
const online = new Set([NODE]);
const linux = (quantity: number) => [{ sku: "Actions Linux", quantity }];

describe("reading the org's Actions usage", () => {
	it("macOS minutes count ×10 and Windows ×2 against the included allotment; other products and units are ignored", () => {
		expect(minuteMultiplier("Actions macOS 3-core")).toBe(10);
		expect(minuteMultiplier("Actions Windows 2-core")).toBe(2);
		expect(minuteMultiplier("Actions Linux")).toBe(1);
		expect(
			actionsMinutesUsed([
				{ product: "Actions", unitType: "Minutes", sku: "Actions Linux", quantity: 100 },
				{ product: "Actions", unitType: "Minutes", sku: "Actions macOS 3-core", quantity: 10 },
				{ product: "Actions", unitType: "GigabyteHours", sku: "Actions storage", quantity: 999 },
				{ product: "Copilot", unitType: "Minutes", sku: "x", quantity: 999 },
			]),
		).toBe(200);
	});

	it("is a share of the PLAN's included minutes (team 3,000), never 'exhausted'", async () => {
		const m = await readOrgMinutes("proappstore-online", sim({ used: linux(2700) }));
		expect(m).toMatchObject({ source: "billing_api", usedMinutes: 2700, includedMinutes: INCLUDED_MINUTES_BY_PLAN.team, minutes: { usedPercent: 90 } });
		expect(m.minutes.exhausted).toBeUndefined();
	});

	it("an explicit includedMinutes wins, and the plan is not even asked", async () => {
		const g = sim({ used: linux(500) });
		const m = await readOrgMinutes("o", g, { includedMinutes: 1000 });
		expect(m.minutes.usedPercent).toBe(50);
		expect(g.calls.some((c) => /\/orgs\/o$/.test(c.url))).toBe(false);
	});

	it("unreadable is stated, with the permission to grant — never read as fine", async () => {
		expect(await readOrgMinutes("o", sim({ usageStatus: 403 }))).toMatchObject({ source: "unreadable", detail: expect.stringMatching(/Administration: Read-only.*#1207/) });
		expect(await readOrgMinutes("o", sim({ noApp: true }))).toMatchObject({ source: "unreadable", detail: expect.stringMatching(/not installed/) });
		expect(await readOrgMinutes("o", sim({ plan: null }))).toMatchObject({ source: "unreadable", detail: expect.stringMatching(/plan could not be read/) });
	});
});

describe("PAGS_RUNNER follows the minutes, and flips back on reset (#1212 acceptance)", () => {
	it("default: plenty of minutes, nothing is written", async () => {
		const g = sim({ used: linux(300) });
		expect(await syncRepoRoutes([repo()], online, g)).toEqual([{ repo: REPO, status: "unchanged", mode: "github-hosted", alert: null }]);
		expect(g.calls.filter((c) => c.method !== "GET")).toEqual([]);
		expect(g.flips).toEqual([]);
	});

	it("at 90% used: the variable is CREATED with exactly the pinned machine's label set — never generic labels", async () => {
		const g = sim({ used: linux(2800) });
		const [r] = await syncRepoRoutes([repo()], online, g);
		expect(r).toMatchObject({ status: "flipped", flip: { from: "github-hosted", to: "self-hosted", reason: "minutes_low", value: LABELS } });
		expect(g.calls).toContainEqual({ method: "POST", url: `https://api.github.com/repos/${REPO}/actions/variables` });
		expect(JSON.parse(g.variables.get(REPO) as string)).toEqual(["self-hosted", "pags-sergeys-mac-mini-local"]);
	});

	it("it is idempotent: the same state again writes nothing and flips nothing", async () => {
		const g = sim({ used: linux(2800) });
		await syncRepoRoutes([repo()], online, g);
		g.calls.length = 0;
		g.flips.length = 0;
		expect(await syncRepoRoutes([repo()], online, g)).toEqual([{ repo: REPO, status: "unchanged", mode: "self-hosted", alert: null }]);
		expect(g.calls.filter((c) => c.method !== "GET")).toEqual([]);
		expect(g.flips).toEqual([]);
	});

	it("the billing cycle resets: the variable is REMOVED (unset = the workflows' pinned GitHub-hosted fallback), not set to ubuntu-latest", async () => {
		const g = sim({ used: linux(2800) });
		await syncRepoRoutes([repo()], online, g);
		g.usage.items = [{ product: "Actions", unitType: "Minutes", sku: "Actions Linux", quantity: 12 }];
		const [r] = await syncRepoRoutes([repo()], online, g);
		expect(r).toMatchObject({ status: "flipped", flip: { from: "self-hosted", to: "github-hosted", value: null, reason: "default" } });
		expect(g.variables.has(REPO)).toBe(false);
		expect(g.calls).toContainEqual({ method: "DELETE", url: `https://api.github.com/repos/${REPO}/actions/variables/PAGS_RUNNER` });
		expect(g.calls.filter((c) => c.method !== "GET" && c.method !== "DELETE" && c.method !== "POST").length).toBe(0);
	});

	it("an existing variable is UPDATED in place, not created again", async () => {
		const g = sim({ used: linux(2800) });
		g.variables.set(REPO, JSON.stringify(["self-hosted", "pags-old-machine"]));
		const [r] = await syncRepoRoutes([repo()], online, g);
		expect(r.status).toBe("flipped");
		expect(g.calls).toContainEqual({ method: "PATCH", url: `https://api.github.com/repos/${REPO}/actions/variables/PAGS_RUNNER` });
		expect(g.variables.get(REPO)).toBe(LABELS);
	});

	it("a run that did not start for billing (#1112) routes self-hosted even when the usage API cannot be read", async () => {
		const g = sim({ usageStatus: 403 });
		const [r] = await syncRepoRoutes([repo({ failureReason: { classification: "minutes_exhausted" } })], online, g);
		expect(r).toMatchObject({ status: "flipped", flip: { to: "self-hosted", reason: "minutes_exhausted" } });
	});

	it("an unreadable org with no other evidence changes nothing", async () => {
		const g = sim({ usageStatus: 500 });
		expect(await syncRepoRoutes([repo()], online, g)).toEqual([{ repo: REPO, status: "unchanged", mode: "github-hosted", alert: null }]);
		expect(g.flips).toEqual([]);
	});

	it("a public or unpinned repo is never routed to a machine, and a stale self-hosted value on one is removed", async () => {
		const g = sim({ used: linux(2900) });
		g.variables.set("o/pub", LABELS);
		const out = await syncRepoRoutes([repo({ repo: "o/pub", visibility: "public" }), repo({ repo: "o/loose", pinnedNode: null })], online, g);
		expect(out.map((r) => r.status)).toEqual(["flipped", "unchanged"]);
		expect(g.variables.size).toBe(0);
	});
});

describe("an offline pinned machine (#1113)", () => {
	it("minutes low but the machine is offline: stays GitHub-hosted, nothing is written, and the owner is told", async () => {
		const g = sim({ used: linux(2800) });
		const [r] = await syncRepoRoutes([repo()], new Set(), g);
		expect(r).toMatchObject({ status: "unchanged", mode: "github-hosted", alert: expect.stringMatching(/offline.*GitHub-hosted/) });
		expect(g.variables.size).toBe(0);
	});

	it("a run that could not start for lack of minutes while the machine is offline: the route is set so jobs wait for it, and the flip alerts — never silent", async () => {
		const g = sim({ usageStatus: 403 });
		const [r] = await syncRepoRoutes([repo({ failureReason: { classification: "minutes_exhausted" } })], new Set(), g);
		expect(r).toMatchObject({ status: "flipped", flip: { to: "self-hosted", reason: "minutes_exhausted", alert: expect.stringMatching(/waiting for .* offline.*exhausted/) } });
		expect(g.variables.get(REPO)).toBe(LABELS);
	});
});

describe("every flip is traced and notified; a refused write claims nothing", () => {
	it("the flip carries the repo, both modes, the reason and a summary the owner can read", async () => {
		const g = sim({ used: linux(2800) });
		await syncRepoRoutes([repo()], online, g);
		expect(g.flips).toHaveLength(1);
		expect(g.flips[0].summary).toMatch(/interns now runs its jobs on self-hosted, pags-sergeys-mac-mini-local.*93\.3%/);
	});

	it("GitHub refusing the write (the App lacks Variables: Read and write) is 'denied' with the permission to grant — no flip, no variable", async () => {
		const g = sim({ used: linux(2800), writeStatus: 403 });
		const [r] = await syncRepoRoutes([repo()], online, g);
		expect(r).toMatchObject({ status: "denied", detail: expect.stringMatching(/Variables: Read and write.*#1207/) });
		expect(g.flips).toEqual([]);
		expect(g.variables.size).toBe(0);
	});

	it("one repo failing does not stop the others; the org's minutes are read once for all its repos", async () => {
		const g = sim({ used: linux(2800) });
		const base = g.fetch;
		g.fetch = async (url, init) => (url.includes("repos/o/boom/") ? new Response("{}", { status: 500 }) : base(url, init));
		const out = await syncRepoRoutes([repo({ repo: "o/boom" }), repo({ repo: "o/ok" })], online, g);
		expect(out.map((r) => r.status)).toEqual(["failed", "flipped"]);
		expect(g.calls.filter((c) => c.url.includes("billing/usage"))).toHaveLength(1);
	});
});
