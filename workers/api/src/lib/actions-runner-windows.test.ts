/**
 * #1272 — the platform's side of the Windows runner: a host that is not ready is registered unrouted with its reasons; a
 * profile-scoped install is migrated (fresh token, staged name, unrouted until proven, rolled back on any failed check), and the
 * token is in nothing that is returned or stored. GitHub and the relay are faked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RealSchemaD1, realSchemaD1, seedTenant } from "./d1-sqlite.js";
import { type ProvisionDeps, startActionsRunner } from "./actions-runner-provision.js";
import type { RunnerConn } from "./runner-client.js";
import type { Env } from "../types.js";

const REG = "AOREGISTRATIONTOKEN1272XXXXXXXXXXXX";
const APP = "ghs_installationtoken1272";
const ORG = "proappstore-online";
const NODE = "pink-laptop";
const LABEL = "pags-pink-laptop";
let d1: RealSchemaD1;
let env: Env;

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["inst-1"] });
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => d1.close());

const WIN_READY = { applicable: true, ready: true, reasons: [], summary: "ok" };
const WIN_NO_AWS = { applicable: true, ready: false, reasons: [{ code: "tool_missing", tool: "aws", message: "`aws` is not on PATH — needed for deploys that run `aws s3 sync`.", remedy: "Install the AWS CLI v2 MSI for all users." }], summary: "This Windows machine is not ready to take jobs and is held out of routing until fixed: aws missing." };

interface Rig extends ProvisionDeps {
	relayed: Array<{ path: string; body: Record<string, unknown> }>;
	puts: Array<{ url: string; labels: string[] }>;
	runnerStatus: { value: string | null };
}

function rig(opts: { windows?: unknown; installed?: unknown[]; migration?: Record<string, unknown>; completeStage?: string; smoke?: ProvisionDeps["smoke"] | null; online?: boolean } = {}): Rig {
	const r: Rig = {
		relayed: [],
		puts: [],
		runnerStatus: { value: null },
		installationToken: async () => APP,
		agentRepos: async () => [`${ORG}/interns`],
		conn: async () => ({ runnerNode: NODE, instanceId: "inst-1" }) as RunnerConn,
		sleep: async () => undefined,
		fetch: async (url, init) => {
			const method = init?.method ?? "GET";
			if (method === "GET" && url.includes("/actions/runners?")) {
				const status = opts.online === false ? "offline" : "online";
				return Response.json({ runners: [{ id: 91, name: `${LABEL}-m`, status, labels: [{ name: "self-hosted", type: "read-only" }, { name: "pags-unavailable", type: "custom" }] }] });
			}
			if (method === "PUT") {
				r.puts.push({ url, labels: (JSON.parse(String(init?.body)) as { labels: string[] }).labels });
				return new Response("{}", { status: 200 });
			}
			return Response.json({ token: REG }, { status: 201 });
		},
		call: async <T>(_c: RunnerConn, path: string, body: unknown) => {
			r.relayed.push({ path, body: body as Record<string, unknown> });
			if (path.endsWith("/capabilities")) return { labels: ["has-git"], missing: [], warnings: [], os: { platform: "win32", version: null }, ...(opts.windows !== undefined ? { windows: opts.windows } : {}) } as T;
			if (path.endsWith("/status")) return { job: null, installed: opts.installed ?? [] } as T;
			if (path.endsWith("/migration/start")) return (opts.migration ?? { stage: "awaiting_verification", stagedName: `${LABEL}-m`, steps: ["old runner is idle", `config.cmd --token ***`], legacyRestored: undefined }) as T;
			if (path.endsWith("/migration/complete")) {
				const v = (body as { verdict: { online: boolean; smoke: { ok: boolean } } }).verdict;
				return (v.online && v.smoke.ok ? { stage: opts.completeStage ?? "ready_for_removal", steps: ["verified; old install is removable (not removed)"] } : { stage: "rolled_back", legacyRestored: true, orphanRegistration: `${LABEL}-m`, steps: [] }) as T;
			}
			return { id: "job-1", action: "install", url: (body as { url: string }).url, name: (body as { name: string }).name, state: "running", steps: [], prerequisites: [], runsAs: "NT AUTHORITY\\NETWORK SERVICE", service: "not_installed" } as T;
		},
	};
	if (opts.smoke !== null) r.smoke = opts.smoke ?? (async () => ({ ok: true }));
	return r;
}

const install = (d: ProvisionDeps) => startActionsRunner(env, { userId: "u1", instanceId: "inst-1", action: "install", scope: { org: ORG } }, d);
const installBody = (r: Rig) => r.relayed.find((x) => x.path.endsWith("/install"))?.body as { labels: string[]; token: string };

describe("host readiness gates routing, not installation (#1272)", () => {
	it("a ready Windows host is registered with the routing labels", async () => {
		const r = rig({ windows: WIN_READY });
		const out = await install(r);
		expect(installBody(r).labels).toEqual(["pags", LABEL, "has-git"]);
		expect(out.preflight?.availability?.available).toBe(true);
	});

	it("the incident: no AWS CLI → the service is still installed, but registered WITHOUT pags / pags-<node>, with the reason and the fix", async () => {
		const r = rig({ windows: WIN_NO_AWS });
		const out = await install(r);
		expect(installBody(r).labels).toEqual(["pags-unavailable", "has-git"]);
		expect(out.labels).not.toContain("pags");
		expect(out.preflight?.availability).toMatchObject({ available: false, reasons: [expect.stringMatching(/aws s3 sync.*Install the AWS CLI v2 MSI/)] });
		expect(out.preflight?.message).toMatch(/UNAVAILABLE for routing/);
		expect(out.preflight?.message).toMatch(/Install the AWS CLI/);
	});

	it("an older runner that cannot report readiness is not refused", async () => {
		const r = rig({});
		await install(r);
		expect(installBody(r).labels).toEqual(["pags", LABEL, "has-git"]);
	});

	it("fixing the host and running setup again swaps the unavailable marker for the routing labels on the registered runner", async () => {
		const installed = [{ dir: "C:\\ProgramData\\ProAgentStore\\actions-runner\\proappstore-online", managed: true, name: LABEL, url: `https://github.com/${ORG}` }];
		const r = rig({ windows: WIN_READY, installed });
		r.fetch = async (url, init) => {
			if ((init?.method ?? "GET") === "GET") return Response.json({ runners: [{ id: 91, name: LABEL, status: "online", labels: [{ name: "self-hosted", type: "read-only" }, { name: "pags-unavailable", type: "custom" }, { name: "has-git", type: "custom" }] }] });
			r.puts.push({ url, labels: (JSON.parse(String(init?.body)) as { labels: string[] }).labels });
			return new Response("{}", { status: 200 });
		};
		const out = await install(r);
		expect(r.puts[0].labels).toEqual(["pags", LABEL, "has-git"]);
		expect(out.refreshed?.changed).toBe(true);
	});

	it("and the other way: a runner that was routable and then loses a tool is pulled out of routing", async () => {
		const installed = [{ dir: "x", managed: true, name: LABEL, url: `https://github.com/${ORG}` }];
		const r = rig({ windows: WIN_NO_AWS, installed });
		r.fetch = async (url, init) => {
			if ((init?.method ?? "GET") === "GET") return Response.json({ runners: [{ id: 91, name: LABEL, status: "online", labels: [{ name: "pags", type: "custom" }, { name: LABEL, type: "custom" }, { name: "has-git", type: "custom" }] }] });
			r.puts.push({ url, labels: (JSON.parse(String(init?.body)) as { labels: string[] }).labels });
			return new Response("{}", { status: 200 });
		};
		await install(r);
		expect(r.puts[0].labels).toEqual(["pags-unavailable", "has-git"]);
	});
});

describe("migrating a profile-scoped install (#1272)", () => {
	const legacy = [{ dir: "C:\\Users\\admin\\.proagentstore\\actions-runner\\proappstore-online", managed: true, name: LABEL, url: `https://github.com/${ORG}`, legacy: true }];
	const startBody = (r: Rig) => r.relayed.find((x) => x.path.endsWith("/migration/start"))?.body as Record<string, unknown>;

	it("a legacy install is migrated, not relabelled or reinstalled: a fresh token goes to /migration/start, the runner is unrouted while unproven", async () => {
		const r = rig({ windows: WIN_READY, installed: legacy });
		const out = await install(r);
		expect(startBody(r)).toMatchObject({ folder: "proappstore-online", url: `https://github.com/${ORG}`, token: REG, labels: ["pags-unavailable", "has-git"] });
		expect(r.relayed.some((x) => x.path.endsWith("/install"))).toBe(false);
		expect(out.migration?.outcome).toBe("ready_for_removal");
	});

	it("online + smoke job passed → verdict reported, the old install is removable, and only now does the runner get the routing labels", async () => {
		const smoked: string[] = [];
		const r = rig({ windows: WIN_READY, installed: legacy, smoke: async (_s, name) => {
			smoked.push(name);
			return { ok: true };
		} });
		r.fetch = async (url, init) => {
			if ((init?.method ?? "GET") === "GET") return Response.json({ runners: [{ id: 91, name: `${LABEL}-m`, status: "online", labels: [{ name: "pags-unavailable", type: "custom" }, { name: "has-git", type: "custom" }] }] });
			if (init?.method === "PUT") r.puts.push({ url, labels: (JSON.parse(String(init.body)) as { labels: string[] }).labels });
			return Response.json({ token: REG }, { status: 201 });
		};
		const out = await install(r);
		expect(smoked).toEqual([`${LABEL}-m`]);
		expect(r.relayed.find((x) => x.path.endsWith("/migration/complete"))?.body).toMatchObject({ verdict: { online: true, smoke: { ok: true } } });
		expect(r.puts[0].labels).toEqual(["pags", LABEL, "has-git"]);
		expect(out.migration?.steps.join("\n")).toMatch(/removable; it has NOT been removed/);
		expect(out.labels).toEqual(["pags", LABEL, "has-git"]);
	});

	it("not shown online by GitHub → the machine is told to roll back to the old runner, and nothing is routed", async () => {
		const r = rig({ windows: WIN_READY, installed: legacy, online: false });
		const out = await install(r);
		expect(out.migration).toMatchObject({ outcome: "rolled_back", legacyRestored: true, orphanRegistration: `${LABEL}-m` });
		expect(r.relayed.find((x) => x.path.endsWith("/migration/complete"))?.body).toMatchObject({ verdict: { online: false } });
		expect(r.puts).toEqual([]);
		expect(out.job.state).toBe("failed");
	});

	it("smoke job failed → rolled back with its detail, never routed", async () => {
		const r = rig({ windows: WIN_READY, installed: legacy, smoke: async () => ({ ok: false, detail: "step 3: aws not found" }) });
		const out = await install(r);
		expect(out.migration?.outcome).toBe("rolled_back");
		expect(out.job.error).toMatch(/smoke job: step 3: aws not found/);
		expect(r.puts).toEqual([]);
	});

	it("no smoke job configured → online but held: stays awaiting verification, unrouted, with exactly what a human must do", async () => {
		const r = rig({ windows: WIN_READY, installed: legacy, smoke: null });
		const out = await install(r);
		expect(out.migration).toMatchObject({ outcome: "awaiting_verification" });
		expect(out.migration?.needsHuman).toMatch(/smoke job.*held out of routing.*old install is stopped but intact/);
		expect(r.relayed.some((x) => x.path.endsWith("/migration/complete"))).toBe(false);
		expect(r.puts).toEqual([]);
		expect(out.labels).toEqual(["pags-unavailable", "has-git"]);
	});

	it("a machine-side rollback (e.g. a failed copy) is reported with the old runner restored", async () => {
		const r = rig({ windows: WIN_READY, installed: legacy, migration: { stage: "rolled_back", error: "disk full", legacyRestored: true, steps: ["copy"] } });
		const out = await install(r);
		expect(out.migration).toMatchObject({ outcome: "rolled_back", legacyRestored: true });
		expect(out.job.error).toBe("disk full");
		expect(r.relayed.some((x) => x.path.endsWith("/migration/complete"))).toBe(false);
	});

	it("a /migration/start the machine cannot run fails with the old runner unchanged, and the token is not in the message", async () => {
		const r = rig({ windows: WIN_READY, installed: legacy });
		const inner = r.call;
		r.call = async <T>(c: RunnerConn, path: string, body: unknown) => {
			if (path.endsWith("/migration/start")) throw new Error(`runner → 500: config failed --token ${REG}`);
			return inner<T>(c, path, body);
		};
		await expect(install(r)).rejects.toThrow(/old runner is unchanged/);
		await install(r).catch((e: Error) => expect(e.message).not.toContain(REG));
	});

	it("the registration token is in no returned value and no stored row", async () => {
		const r = rig({ windows: WIN_READY, installed: legacy });
		const out = await install(r);
		expect(JSON.stringify(out)).not.toContain(REG);
		const tables = (d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
		const dump = tables.map((t) => JSON.stringify(d1.sqlite.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
		expect(dump).not.toContain(REG);
		expect(dump).not.toContain(APP);
		expect(dump).toContain("actions_runner.migration_complete");
	});

	it("a runner that is not a legacy install is untouched by migration", async () => {
		const r = rig({ windows: WIN_READY, installed: [{ dir: "C:\\ProgramData\\ProAgentStore\\actions-runner\\proappstore-online", managed: true, name: LABEL, url: `https://github.com/${ORG}` }] });
		r.fetch = async () => Response.json({ runners: [{ id: 1, name: LABEL, status: "online", labels: [{ name: "pags", type: "custom" }, { name: LABEL, type: "custom" }, { name: "has-git", type: "custom" }] }] });
		await install(r);
		expect(r.relayed.some((x) => x.path.includes("/migration"))).toBe(false);
	});
});
