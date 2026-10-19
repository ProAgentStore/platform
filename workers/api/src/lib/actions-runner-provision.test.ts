/**
 * #1208 — a runner registration token is minted server-side, handed to the machine, and stored nowhere.
 *
 * Over the real schema, with GitHub and the relay faked and every request recorded. The acceptance
 * test dumps every table in D1 and every console line after a full install request and finds no token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { actionsRunnerStatus, mintRunnerToken, type ProvisionDeps, parseRunnerScope, startActionsRunner } from "./actions-runner-provision.js";
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
		expect(d.relayed).toEqual([{ path: "/coding/actions-runner/install", body: { url: "https://github.com/proappstore-online", token: REG_TOKEN, name: "pags-pink-laptop", labels: ["pags", "pags-pink-laptop"] } }]);
		expect(out).toMatchObject({ node: NODE, labels: ["pags", "pags-pink-laptop"], job: { id: "job-1", state: "running" } });

		expect(JSON.stringify(out)).not.toContain(REG_TOKEN);
		const stored = dumpD1();
		expect(stored).toContain("actions_runner.install_started"); // the request IS recorded…
		expect(stored).not.toContain(REG_TOKEN); // …the token is not
		expect(stored).not.toContain(APP_TOKEN);
		expect(lines.join("\n")).not.toContain(REG_TOKEN);
	});

	it("a repo-scoped install mints at the repo, and a remove mints a REMOVAL token", async () => {
		const d = deps();
		await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { repo: "proappstore-online/interns" } }, d);
		await startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "remove", scope: { repo: "proappstore-online/interns" } }, d);
		expect(d.github.filter((g) => g.method === "POST").map((g) => g.url)).toEqual([
			"https://api.github.com/repos/proappstore-online/interns/actions/runners/registration-token",
			"https://api.github.com/repos/proappstore-online/interns/actions/runners/remove-token",
		]);
		expect(d.relayed.map((r) => [r.path, r.body.token])).toEqual([
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
		expect(d.relayed).toEqual([]);
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

describe("status", () => {
	it("reads the job and every runner on the machine — including a hand install", async () => {
		const d = deps();
		const s = await actionsRunnerStatus(env, { userId: "u1", instanceId: "inst-1", jobId: "job-1" }, d);
		expect(d.relayed).toEqual([{ path: "/coding/actions-runner/status", body: { jobId: "job-1" } }]);
		expect(s).toMatchObject({ node: NODE, installed: [{ managed: false, name: "pink-laptop" }] });
	});
});
