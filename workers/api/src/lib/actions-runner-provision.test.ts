/**
 * #1208 — a runner registration token is minted server-side, handed to the machine, and stored nowhere.
 *
 * Over the real schema, with GitHub and the relay faked and every request recorded. The acceptance
 * test dumps every table in D1 and every console line after a full install request and finds no token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { actionsRunnerStatus, mintRunnerToken, type ProvisionDeps, parseRunnerScope, recoverActionsRunner, scopeFromRunnerUrl, startActionsRunner } from "./actions-runner-provision.js";
import type { RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

const REG_TOKEN = "AOREGISTRATIONTOKEN1208XXXXXXXXXXXX";
const REMOVE_TOKEN = "AOREMOVETOKEN1208YYYYYYYYYYYYYYYYYY";
const APP_TOKEN = "ghs_installationtoken1208";
const NODE = "pink-laptop";

let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => {
	d1.close();
	vi.restoreAllMocks();
});

interface Fake extends ProvisionDeps {
	github: Array<{ url: string; method: string; auth: string | null }>;
	relayed: Array<{ path: string; body: Record<string, unknown> }>;
}

function deps(over: Partial<ProvisionDeps> & { githubStatus?: number; visibility?: string } = {}): Fake {
	const f: Fake = {
		github: [],
		relayed: [],
		installationToken: async () => APP_TOKEN,
		agentRepos: async () => ["proappstore-online/interns"],
		conn: async () => ({ runnerNode: NODE, instanceId: "inst-1" }) as RunnerConn,
		fetch: async (url, init) => {
			f.github.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("Authorization") });
			if (url.endsWith("/repos/proappstore-online/interns")) return Response.json({ visibility: over.visibility ?? "private" });
			if (over.githubStatus) return new Response("{}", { status: over.githubStatus });
			return Response.json({ token: url.endsWith("remove-token") ? REMOVE_TOKEN : REG_TOKEN, expires_at: "2026-10-19T12:00:00Z" }, { status: 201 });
		},
		call: async <T>(_conn: RunnerConn, path: string, body: unknown) => {
			f.relayed.push({ path, body: body as Record<string, unknown> });
			if (path.endsWith("/status")) return { job: null, installed: [{ dir: "/x", managed: false, name: "pink-laptop", url: "https://github.com/proappstore-online/interns" }] } as T;
			return { id: "job-1", action: path.endsWith("install") ? "install" : "remove", url: (body as { url: string }).url, name: (body as { name: string }).name, state: "running", steps: [], prerequisites: [], runsAs: "serge", service: "not_installed" } as T;
		},
		...over,
	};
	return f;
}

/** The requests that CHANGE the machine (install / remove) — its capability and status reads (#1260) are read-only. */
const changing = (f: Fake) => f.relayed.filter((r) => !/\/(status|capabilities)$/.test(r.path));

/** Every row of every table, as one string. */
function dumpD1(): string {
	const tables = (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
	return tables.map((t) => JSON.stringify(d1.sqlite.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
}

describe("the token is minted, delivered, and stored nowhere (#1208 acceptance)", () => {
	it("an org-scoped install: minted with the App's installation token, handed to the machine with the pags labels — and absent from D1, the trace and every console line", async () => {
		const lines: string[] = [];
		for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
		const d = deps();
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, d);

		expect(d.github).toContainEqual({ url: "https://api.github.com/orgs/proappstore-online/actions/runners/registration-token", method: "POST", auth: `Bearer ${APP_TOKEN}` });
		expect(changing(d)).toEqual([{ path: "/coding/actions-runner/install", body: { url: "https://github.com/proappstore-online", token: REG_TOKEN, name: "pags-pink-laptop", labels: ["pags", "pags-pink-laptop"] } }]);
		expect(out).toMatchObject({ node: NODE, labels: ["pags", "pags-pink-laptop"], job: { id: "job-1", state: "running" } });

		expect(JSON.stringify(out)).not.toContain(REG_TOKEN);
		const stored = dumpD1();
		expect(stored).toContain("actions_runner.install_started"); // the request IS recorded…
		expect(stored).not.toContain(REG_TOKEN); // …the token is not
		expect(stored).not.toContain(APP_TOKEN);
		expect(lines.join("\n")).not.toContain(REG_TOKEN);
	});

	it("forwards an explicit macOS system-service opt-in without changing the default request", async () => {
		const d = deps();
		await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" }, serviceMode: "macos_system" }, d);
		expect(changing(d)).toEqual([{ path: "/coding/actions-runner/install", body: expect.objectContaining({ serviceMode: "macos_system" }) }]);
	});

	it("a repo-scoped install mints at the repo, and a remove mints a REMOVAL token", async () => {
		const d = deps();
		await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { repo: "proappstore-online/interns" } }, d);
		await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "remove", scope: { repo: "proappstore-online/interns" } }, d);
		expect(d.github.filter((g) => g.method === "POST").map((g) => g.url)).toEqual([
			"https://api.github.com/repos/proappstore-online/interns/actions/runners/registration-token",
			"https://api.github.com/repos/proappstore-online/interns/actions/runners/remove-token",
		]);
		expect(changing(d).map((r) => [r.path, r.body.token])).toEqual([
			["/coding/actions-runner/install", REG_TOKEN],
			["/coding/actions-runner/remove", REMOVE_TOKEN],
		]);
		expect(dumpD1()).not.toContain(REMOVE_TOKEN);
	});
});

describe("refusals: nothing is minted, nothing reaches the machine", () => {
	it("before #1207 is accepted, GitHub's 403 names the permission to grant", async () => {
		const d = deps({ githubStatus: 403 });
		await expect(startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, d)).rejects.toThrow(/Self-hosted runners: Read and write.*#1207/);
		await expect(mintRunnerToken({ repo: "proappstore-online/interns" }, "registration", deps({ githubStatus: 403 }))).rejects.toThrow(/Administration: Read and write/);
		expect(changing(d)).toEqual([]); // the capability and status reads are read-only; nothing was installed or removed
	});

	it("an org or repo this agent does not work on is refused before anything is minted", async () => {
		const d = deps();
		await expect(startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "someone-else" } }, d)).rejects.toThrow(/not the owner of a repository this agent works on/);
		await expect(startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { repo: "proappstore-online/other" } }, d)).rejects.toThrow(/not a repository this agent works on/);
		expect(d.github.filter((g) => g.method === "POST")).toEqual([]);
	});

	it("a public repo never gets a runner", async () => {
		const d = deps({ visibility: "public" });
		await expect(startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { repo: "proappstore-online/interns" } }, d)).rejects.toThrow(/is public.*private repositories only/);
		expect(d.github.filter((g) => g.method === "POST")).toEqual([]);
	});

	it("no machine connected, the App not installed, or a runner too old to answer — each says what to do", async () => {
		await expect(startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, deps({ conn: async () => null }))).rejects.toThrow(/pags up/);
		await expect(startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, deps({ installationToken: async () => null }))).rejects.toThrow(/not installed on proappstore-online/);
		const old = deps({ call: async () => Promise.reject(new Error('Runner /coding/actions-runner/install → 404: {"error":"Not found"}')) });
		await expect(startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, old)).rejects.toThrow(/CLI 0\.4\.162/);
	});

	it("a scope must be exactly an org or exactly an owner/name repo", () => {
		expect(parseRunnerScope({ org: "pas-apps" })).toEqual({ org: "pas-apps" });
		expect(parseRunnerScope({ repo: "proappstore-online/interns" })).toEqual({ repo: "proappstore-online/interns" });
		expect(() => parseRunnerScope({ org: "a", repo: "a/b" })).toThrow(/scope must be/);
		expect(() => parseRunnerScope({ repo: "no-slash" })).toThrow(/scope must be/);
	});
});

describe("status shows GitHub's view of each runner (#1213)", () => {
	const listing = (runner: Record<string, unknown> | null, status = 200) => async (url: string): Promise<Response> =>
		url.includes("/actions/runners") ? (status === 200 ? Response.json({ runners: runner ? [runner] : [] }) : new Response("{}", { status })) : Response.json({});

	it("online, busy and labels, and whether jobs can be routed to it", async () => {
		const d = deps({ fetch: listing({ id: 7, name: "pink-laptop", status: "online", busy: true, labels: [{ name: "self-hosted", type: "read-only" }, { name: "pags", type: "custom" }, { name: "pags-pink-laptop", type: "custom" }] }) });
		const s = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, d);
		expect(s.installed[0].ci).toMatchObject({ registered: true, online: true, busy: true, routable: true, labels: ["self-hosted", "pags", "pags-pink-laptop"] });
		expect(s.installed[0].ciNote).toBeUndefined();
	});

	it("a runner GitHub has never heard of is registered: false, not an error", async () => {
		const s = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, deps({ fetch: listing(null) }));
		expect(s.installed[0].ci).toMatchObject({ registered: false, routable: false });
	});

	it("GitHub refusing (the App lacks the runner permission, #1207) leaves the runner listed with the reason — the status does not fail", async () => {
		const s = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, deps({ fetch: listing(null, 403) }));
		expect(s.installed[0]).toMatchObject({ name: "pink-laptop", managed: false });
		expect(s.installed[0].ci).toBeUndefined();
		expect(s.installed[0].ciNote).toMatch(/could not be read.*403/);
	});

	it("the App not installed on the owner: same, with the reason", async () => {
		const s = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, deps({ installationToken: async () => null }));
		expect(s.installed[0].ciNote).toMatch(/not installed/);
	});

	it("a runner with no name or an unreadable URL is listed as the machine reported it, GitHub not asked", async () => {
		const d = deps({ call: async <T>() => ({ job: null, installed: [{ dir: "/x", managed: false, name: null, url: null }] }) as T });
		const s = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, d);
		expect(s.installed).toEqual([{ dir: "/x", managed: false, name: null, url: null, localHealth: "unknown", ciNote: expect.stringMatching(/GitHub's view is unknown/) }]);
		expect(d.github).toEqual([]);
	});

	it("runner URLs map to their scope", () => {
		expect(scopeFromRunnerUrl("https://github.com/proappstore-online")).toEqual({ org: "proappstore-online" });
		expect(scopeFromRunnerUrl("https://github.com/proappstore-online/interns/")).toEqual({ repo: "proappstore-online/interns" });
		expect(scopeFromRunnerUrl("https://example.com/x")).toBeNull();
		expect(scopeFromRunnerUrl(null)).toBeNull();
	});
});

describe("local supervisor status and explicit recovery (#1367)", () => {
	it("says unknown when the pinned machine cannot answer, without claiming an installed runner is healthy", async () => {
		const offline = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, deps({ conn: async () => null }));
		expect(offline).toMatchObject({ node: null, machineHealth: "unknown", installed: [], job: null });
		const unreachable = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, deps({ call: async () => { throw new Error("relay timed out"); } }));
		expect(unreachable).toMatchObject({ node: NODE, machineHealth: "unknown", installed: [], machineNote: expect.stringMatching(/relay timed out/) });
	});

	it("treats an incomplete runner list as unknown instead of claiming none are installed", async () => {
		for (const body of [{}, { installed: null }, { installed: [null] }]) {
			const status = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, deps({ call: async <T>() => body as T }));
			expect(status).toMatchObject({ node: NODE, machineHealth: "unknown", installed: [], machineNote: expect.stringMatching(/invalid Actions runner list/) });
		}
	});

	it("keeps the GitHub view separate and marks an old local sample stale", async () => {
		const d = deps({
			call: async <T>() => ({ job: null, installed: [{ dir: "/x", managed: true, name: "pink-laptop", url: "https://github.com/proappstore-online/interns", serviceMode: "macos_system", supervisor: { health: "ready", updatedAt: Date.now() - 120_000, lastReadyAt: Date.now() - 120_000 } }] }) as T,
			fetch: async () => Response.json({ runners: [{ id: 7, name: "pink-laptop", status: "online", busy: false, labels: [{ name: "pags", type: "custom" }, { name: "pags-pink-laptop", type: "custom" }] }] }),
		});
		const s = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, d);
		expect(s.installed[0]).toMatchObject({ serviceMode: "macos_system", localHealth: "stale", supervisor: { health: "ready" }, ci: { online: true, busy: false } });
	});

	it("marks a fresh supervisor stale when its CLI differs from the approved payload", async () => {
		const d = deps({ call: async <T>() => ({ job: null, installed: [{ dir: "/x", managed: true, name: "pink-laptop", url: "https://github.com/proappstore-online/interns", supervisor: { health: "ready", updatedAt: Date.now(), cliVersion: "0.4.184", approvedCliVersion: "0.4.185" } }] }) as T });
		const s = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1" }, d);
		expect(s.installed[0]).toMatchObject({ localHealth: "stale", versionSkew: true, supervisor: { cliVersion: "0.4.184", approvedCliVersion: "0.4.185" } });
	});

	it("targets one scope and returns the machine's durable receipt without minting a token", async () => {
		const d = deps({ call: async <T>(_conn: RunnerConn, path: string, _body: unknown) => {
			if (path === "/coding/actions-runner/recover") return { id: "rec-1", state: "deferred_active_job", requestedAt: 123 } as T;
			return { job: null, installed: [] } as T;
		} });
		const r = await recoverActionsRunner(env, { userId: "u1", instanceId: "inst-1", scope: { org: "proappstore-online" } }, d);
		expect(r).toMatchObject({ node: NODE, recovery: { id: "rec-1", state: "deferred_active_job" } });
		expect(d.github).toEqual([]); // local recovery must work even when the GitHub App cannot be read
		await expect(recoverActionsRunner(env, { userId: "u1", instanceId: "inst-1", scope: { org: "another-org" } }, d)).rejects.toThrow(/not the owner of a repository/);
	});
});

describe("status", () => {
	it("reads the job and every runner on the machine — including a hand install", async () => {
		const d = deps();
		const s = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1", jobId: "job-1" }, d);
		expect(d.relayed).toEqual([{ path: "/coding/actions-runner/status", body: { jobId: "job-1" } }]);
		expect(s).toMatchObject({ node: NODE, installed: [{ managed: false, name: "pink-laptop" }] });
	});
});

// ── #1260: capability labels, the preflight, and the label refresh ────────────────────────────────────

const REPORT = (over: Record<string, unknown> = {}) => ({
	labels: ["has-brew", "has-git", "has-node", "macos-11+", "macos-12+", "macos-13+", "macos-14+"],
	missing: [{ tool: "jq", hint: "brew install jq (macOS) · apt install jq (Linux)" }, { tool: "flutter", hint: "https://docs.flutter.dev/get-started/install" }],
	warnings: [] as string[],
	os: { platform: "darwin", version: "14.5" },
	...over,
});

/** A machine that answers capabilities (or does not), and whose installed list the test controls. */
function machine(opts: { capabilities?: unknown | Error; installed?: Array<{ name: string | null; url: string | null }> }) {
	const d = deps();
	const inner = d.call;
	d.call = async <T>(conn: RunnerConn, path: string, body: unknown) => {
		if (path.endsWith("/capabilities")) {
			d.relayed.push({ path, body: body as Record<string, unknown> });
			if (opts.capabilities instanceof Error) throw opts.capabilities;
			return (opts.capabilities ?? REPORT()) as T;
		}
		if (path.endsWith("/status") && opts.installed) {
			d.relayed.push({ path, body: body as Record<string, unknown> });
			return { job: null, installed: opts.installed } as T;
		}
		return inner<T>(conn, path, body);
	};
	return d;
}

describe("capability labels join the runner's labels (#1260)", () => {
	it("asks the machine what it can run BEFORE registering, and sends its labels beside pags and pags-<node>", async () => {
		const d = machine({});
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, d);
		const expected = ["pags", "pags-pink-laptop", "has-brew", "has-git", "has-node", "macos-11+", "macos-12+", "macos-13+", "macos-14+"];
		expect(out.labels).toEqual(expected);
		expect(changing(d)).toEqual([{ path: "/coding/actions-runner/install", body: expect.objectContaining({ name: "pags-pink-laptop", labels: expected }) }]);
		// asked first
		expect(d.relayed[0].path).toBe("/coding/actions-runner/capabilities");
		expect(JSON.stringify(out)).not.toContain(REG_TOKEN);
	});

	it("the preflight names each missing CI tool and how to install it, and never blocks the registration", async () => {
		const d = machine({});
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, d);
		expect(out.preflight?.missing.map((m) => m.tool)).toEqual(["jq", "flutter"]);
		expect(out.preflight?.message).toMatch(/lacks `jq`, `flutter`/);
		expect(out.preflight?.message).toMatch(/jq — brew install jq/);
		expect(out.preflight?.message).toMatch(/has-<tool>/);
		expect(changing(d)).toHaveLength(1); // registered anyway: informational
	});

	it("an OS warning (macOS too old for Flutter) is carried into the preflight", async () => {
		const warning = "macOS 12.7 is older than 14: Flutter 3.41's Dart VM will not start here.";
		const d = machine({ capabilities: REPORT({ warnings: [warning], labels: ["has-git", "macos-11+", "macos-12+"], missing: [] }) });
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, d);
		expect(out.preflight?.message).toContain(warning);
		expect(out.labels).not.toContain("macos-14+");
	});

	it("a fully equipped machine says so", async () => {
		const d = machine({ capabilities: REPORT({ missing: [] }) });
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, d);
		expect(out.preflight?.message).toMatch(/has the CI tools checked/);
	});

	it("a runner too old to answer (404) or a failed check registers with the base labels only — and the preflight says it could not check", async () => {
		for (const err of [new Error("POST /coding/actions-runner/capabilities → 404"), new Error("socket closed")]) {
			const d = machine({ capabilities: err });
			const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, d);
			expect(out.labels).toEqual(["pags", "pags-pink-laptop"]);
			expect(out.capabilities).toBeNull();
			expect(out.preflight?.message).toMatch(/could not report its tools/);
			expect(changing(d)).toHaveLength(1);
		}
	});

	it("labels the machine sends that are not valid runner labels are dropped, not forwarded to GitHub", async () => {
		const d = machine({ capabilities: REPORT({ labels: ["has-jq", "has jq", "x".repeat(101), "$(rm -rf)", 5, "macos-14+"] }) });
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: "proappstore-online" } }, d);
		expect(out.labels).toEqual(["pags", "pags-pink-laptop", "has-jq", "macos-14+"]);
	});

	it("a removal does not ask for capabilities", async () => {
		const d = machine({});
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "remove", scope: { org: "proappstore-online" } }, d);
		expect(d.relayed.some((r) => r.path.endsWith("/capabilities"))).toBe(false);
		expect(out.preflight).toBeUndefined();
	});
});

describe("refreshing the labels of a runner that is already registered (#1260)", () => {
	const ORG = "proappstore-online";
	const installed = [{ name: "pags-pink-laptop", url: `https://github.com/${ORG}` }];

	function github(runnerLabels: Array<{ name: string; type: string }>, over: { listStatus?: number; putStatus?: number; name?: string } = {}) {
		const calls: Array<{ method: string; url: string; body?: unknown }> = [];
		const fetch = async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
			if (method === "GET" && url.includes("/actions/runners?")) {
				if (over.listStatus) return new Response("{}", { status: over.listStatus });
				return Response.json({ runners: [{ id: 77, name: over.name ?? "pags-pink-laptop", labels: runnerLabels }] });
			}
			if (method === "PUT") return new Response(JSON.stringify({}), { status: over.putStatus ?? 200 });
			return Response.json({ token: REG_TOKEN }, { status: 201 });
		};
		return { calls, fetch };
	}
	const base = [{ name: "self-hosted", type: "read-only" }, { name: "macOS", type: "read-only" }, { name: "ARM64", type: "read-only" }];

	it("re-running setup relabels at GitHub and reconciles the local service without minting a token", async () => {
		const gh = github([...base, { name: "pags", type: "custom" }, { name: "pags-pink-laptop", type: "custom" }, { name: "has-jq", type: "custom" }, { name: "macos-12+", type: "custom" }, { name: "team-ios", type: "custom" }]);
		const d = machine({ installed });
		d.fetch = gh.fetch;
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: ORG } }, d);
		const put = gh.calls.find((c) => c.method === "PUT");
		expect(put?.url).toBe(`https://api.github.com/orgs/${ORG}/actions/runners/77/labels`);
		expect(put?.body).toEqual({ labels: ["team-ios", "pags", "pags-pink-laptop", "has-brew", "has-git", "has-node", "macos-11+", "macos-12+", "macos-13+", "macos-14+"] });
		expect(out.refreshed).toMatchObject({ changed: true });
		expect(out.job).toMatchObject({ state: "running" });
		expect(out.job.steps[0]).toMatch(/relabelled at GitHub/);
		expect(gh.calls.some((c) => c.url.endsWith("registration-token"))).toBe(false);
		expect(changing(d)).toEqual([{ path: "/coding/actions-runner/reconcile", body: { url: `https://github.com/${ORG}`, name: "pags-pink-laptop" } }]);
		expect(JSON.stringify(out)).not.toContain(APP_TOKEN);
	});

	it("passes explicit system mode through existing .runner reconciliation", async () => {
		const gh = github(base);
		const d = machine({ installed });
		d.fetch = gh.fetch;
		await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: ORG }, serviceMode: "macos_system" }, d);
		expect(changing(d)).toEqual([{ path: "/coding/actions-runner/reconcile", body: { url: `https://github.com/${ORG}`, name: "pags-pink-laptop", serviceMode: "macos_system" } }]);
	});

	it("labels that already match are left alone: no PUT", async () => {
		const desired = ["pags", "pags-pink-laptop", "has-brew", "has-git", "has-node", "macos-11+", "macos-12+", "macos-13+", "macos-14+"];
		const gh = github([...base, ...desired.map((name) => ({ name, type: "custom" }))]);
		const d = machine({ installed });
		d.fetch = gh.fetch;
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: ORG } }, d);
		expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);
		expect(out.refreshed?.changed).toBe(false);
		expect(out.job.steps[0]).toMatch(/already match/);
	});

	it("a runner registered under another scope is not 'installed' here: it installs normally", async () => {
		const gh = github(base);
		const d = machine({ installed: [{ name: "pags-pink-laptop", url: "https://github.com/someone-else" }] });
		d.fetch = async (url, init) => (url.includes("/actions/runners") && !url.endsWith("registration-token") ? gh.fetch(url, init) : Response.json({ token: REG_TOKEN }, { status: 201 }));
		const out = await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: ORG } }, d);
		expect(changing(d).map((r) => r.path)).toEqual(["/coding/actions-runner/install"]);
		expect(out.refreshed).toBeUndefined();
	});

	it("GitHub's 403 names the permission to grant; a runner GitHub does not know says to reinstall — each changes nothing", async () => {
		const denied = github(base, { listStatus: 403 });
		const d1 = machine({ installed });
		d1.fetch = denied.fetch;
		await expect(startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: ORG } }, d1)).rejects.toThrow(/Self-hosted runners: Read and write/);
		const unknown = github(base, { name: "some-other-runner" });
		const d2 = machine({ installed });
		d2.fetch = unknown.fetch;
		await expect(startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: ORG } }, d2)).rejects.toThrow(/No runner named pags-pink-laptop is registered/);
		expect(unknown.calls.some((c) => c.method === "PUT")).toBe(false);
	});

	it("a repo-scoped runner is relabelled at the repo", async () => {
		const gh = github([...base, { name: "has-jq", type: "custom" }]);
		const d = machine({ installed: [{ name: "pags-pink-laptop", url: "https://github.com/proappstore-online/interns" }] });
		d.fetch = async (url, init) => (url.endsWith("/repos/proappstore-online/interns") ? Response.json({ visibility: "private" }) : gh.fetch(url, init));
		await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { repo: "proappstore-online/interns" } }, d);
		expect(gh.calls.find((c) => c.method === "PUT")?.url).toBe("https://api.github.com/repos/proappstore-online/interns/actions/runners/77/labels");
	});
});
