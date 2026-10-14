/**
 * #1081 — an org the App was installed on AFTER the last Connect GitHub is never bound, and nothing
 * said why. Over the real D1 schema, with a fake GitHub routed by URL:
 *
 *  - the App's installation list is read across EVERY page (`Link: rel="next"`), not just the first 30;
 *  - `syncUserInstallations` binds exactly what the existing proof allows — a personal login match, or
 *    an ACTIVE org membership — and names the step that refused everything else;
 *  - `bindMemberOrgInstallations` (the link flow) reports every outcome instead of dropping failures;
 *  - account isolation: an installation this user is not part of is never named, never bound, and a
 *    "not a member" is never even counted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, type RealSchemaD1 } from "./d1-sqlite.js";
import { bindMemberOrgInstallations, cacheInstallationToken, listInstallations, nextPageUrl, resolveGithubAccess } from "./github-app.js";
import { disclosedOutcomes, syncUserInstallations } from "./github-installation-sync.js";
import type { Env } from "../types.js";

vi.mock("./auth.js", async (orig) => ({ ...(await orig<typeof import("./auth.js")>()), requireUser: async () => ({ uid: "u1", roles: [] }) }));
const { githubRoutes } = await import("../routes/github.js");

async function pem(): Promise<string> {
	const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
	let bin = "";
	for (const b of der) bin += String.fromCharCode(b);
	return `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----`;
}

type Inst = { id: number; account: { login: string; type: string } };
const org = (id: number, login: string): Inst => ({ id, account: { login, type: "Organization" } });
const user = (id: number, login: string): Inst => ({ id, account: { login, type: "User" } });

/** Every installation of the App, across all tenants — two pages, as GitHub would page them. */
const PAGE1: Inst[] = [user(1, "octo"), org(2, "acme"), org(3, "chessclubs-online"), org(4, "other-co"), user(5, "someone-else"), org(6, "pending-co"), org(7, "old-co")];
const PAGE2: Inst[] = [org(8, "page-two-co")];

interface Fake {
	/** What the App's own token reads at /orgs/:org/memberships/:login, per org. */
	appMembership: Record<string, { status: number; body: unknown }>;
	/** What the USER's token reads at /user/memberships/orgs/:org, per org. */
	userMembership: Record<string, { status: number; body: unknown }>;
	/** Installation ids GitHub refuses to mint a token for. */
	mintRefused: Set<number>;
	calls: string[];
}

let fake: Fake;
let d1: RealSchemaD1;
let env: Env;

function routeGithub() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const u = String(url);
			fake.calls.push(`${init?.method ?? "GET"} ${u}`);
			const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
			if (u === "https://api.github.com/app/installations") return json(200, PAGE1, { link: '<https://api.github.com/app/installations?page=2>; rel="next", <https://api.github.com/app/installations?page=2>; rel="last"' });
			if (u === "https://api.github.com/app/installations?page=2") return json(200, PAGE2);
			const mint = u.match(/\/app\/installations\/(\d+)\/access_tokens$/);
			if (mint) return fake.mintRefused.has(Number(mint[1])) ? json(500, {}) : json(201, { token: `ghs_${mint[1]}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
			const appM = u.match(/\/orgs\/([^/]+)\/memberships\/([^/]+)$/);
			if (appM) {
				const r = fake.appMembership[decodeURIComponent(appM[1])] ?? { status: 404, body: { message: "Not Found" } };
				// The App reads membership for the LINKED login only — anyone else is not a member.
				return decodeURIComponent(appM[2]) === "octo" ? json(r.status, r.body) : json(404, { message: "Not Found" });
			}
			const userM = u.match(/\/user\/memberships\/orgs\/([^/]+)$/);
			if (userM) {
				const r = fake.userMembership[decodeURIComponent(userM[1])] ?? { status: 404, body: { message: "Not Found" } };
				return json(r.status, r.body);
			}
			return json(404, { message: "Not Found" });
		}),
	);
}

const bindings = (uid: string) => (d1.sqlite.prepare("SELECT installation_id FROM github_installations WHERE user_id = ? ORDER BY installation_id").all(uid) as Array<{ installation_id: number }>).map((r) => r.installation_id);

beforeEach(async () => {
	d1 = realSchemaD1();
	d1.exec(`INSERT INTO users (id, github_login, linked_github_login) VALUES ('u1', 'owner@example.com', 'octo'), ('u2', 'mallory@example.com', 'mallory'), ('u3', 'nolink@example.com', NULL)`);
	env = { DB: d1.DB, GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: await pem(), GITHUB_APP_SLUG: "pags" } as unknown as Env;
	fake = {
		appMembership: {
			acme: { status: 200, body: { state: "active" } },
			"chessclubs-online": { status: 403, body: { message: "Resource not accessible by integration" } },
			"pending-co": { status: 200, body: { state: "pending" } },
			"page-two-co": { status: 200, body: { state: "active" } },
		},
		userMembership: {},
		mintRefused: new Set(),
		calls: [],
	};
	routeGithub();
	// u1 already holds a verified binding to old-co (7) from an earlier Connect.
	await cacheInstallationToken(env, "u1", 7, "ghs_old", new Date(Date.now() + 3600e3).toISOString(), { login: "old-co", type: "Organization" });
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

describe("the App's installation list is read across every page", () => {
	it("follows Link: rel=next, so an org on page 2 is installed — not `not-installed`", async () => {
		expect((await listInstallations(env)).map((i) => i.account.login)).toContain("page-two-co");
		await cacheInstallationToken(env, "u1", 8, "ghs_8", new Date(Date.now() + 3600e3).toISOString(), { login: "page-two-co", type: "Organization" });
		expect(await resolveGithubAccess(env, "u1", "page-two-co")).toMatchObject({ ok: true });
	});

	it("never follows a Link to anywhere but api.github.com — the App JWT stays home", () => {
		expect(nextPageUrl('<https://api.github.com/app/installations?page=3>; rel="next"')).toBe("https://api.github.com/app/installations?page=3");
		expect(nextPageUrl('<https://evil.example/steal>; rel="next"')).toBeNull();
		expect(nextPageUrl('<https://api.github.com/app/installations?page=1>; rel="prev"')).toBeNull();
		expect(nextPageUrl(null)).toBeNull();
	});
});

describe("syncUserInstallations — binds what the existing proof allows, and says why not", () => {
	it("binds a personal match and every ACTIVE membership — and nothing else", async () => {
		const r = await syncUserInstallations(env, "u1");
		expect(r.bound).toBe(3);
		expect(bindings("u1")).toEqual([1, 2, 7, 8]);
		expect(r.orgs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ account: "octo", result: "bound" }),
				expect.objectContaining({ account: "acme", result: "bound" }),
				expect.objectContaining({ account: "page-two-co", result: "bound" }),
				expect.objectContaining({ account: "old-co", result: "already_bound" }),
				expect.objectContaining({ account: "pending-co", result: "not_bound", reason: "membership_pending" }),
			]),
		);
		// The App could not read membership somewhere: a FLAG, not a list of other tenants.
		expect(r.appCannotReadMembers).toBe(true);
	});

	it("account isolation: an installation this user is not part of is never named — and 'not a member' is not even counted", async () => {
		const r = await syncUserInstallations(env, "u1");
		const named = r.orgs.map((o) => o.account);
		for (const other of ["other-co", "someone-else", "chessclubs-online"]) expect(named).not.toContain(other);
		expect(r.unnamed).not.toHaveProperty("not_member");
		expect(r.unnamed).not.toHaveProperty("not_owner");
		expect(JSON.stringify(r)).not.toMatch(/ghs_|Bearer|access_tokens/);
	});

	it("NAMING the org gets its exact refusal — the step that failed and GitHub's status", async () => {
		const r = await syncUserInstallations(env, "u1", { owner: "ChessClubs-Online" });
		expect(r.orgs).toEqual([{ account: "chessclubs-online", type: "Organization", installationId: 3, result: "not_bound", reason: "app_cannot_read_members", status: 403 }]);
		expect(r.bound).toBe(0);
		expect(bindings("u1")).toEqual([7]);
	});

	it("a named org the App is not installed on says so", async () => {
		expect((await syncUserInstallations(env, "u1", { owner: "nowhere-co" })).orgs).toEqual([{ account: "nowhere-co", type: "", installationId: 0, result: "not_installed" }]);
	});

	it("dry run runs every check and writes nothing", async () => {
		const r = await syncUserInstallations(env, "u1", { dryRun: true });
		expect(r.dryRun).toBe(true);
		expect(r.bound).toBe(0);
		expect(r.orgs).toEqual(expect.arrayContaining([expect.objectContaining({ account: "acme", result: "would_bind" })]));
		expect(bindings("u1")).toEqual([7]);
	});

	it("CROSS-ACCOUNT: another user can never bind this user's orgs or personal install, and sees none of them", async () => {
		const r = await syncUserInstallations(env, "u2");
		expect(r.bound).toBe(0);
		expect(bindings("u2")).toEqual([]);
		expect(r.orgs).toEqual([]);
		expect(JSON.stringify(r)).not.toMatch(/acme|octo|old-co|page-two-co/);
		// Naming someone else's org reveals only what resolveGithubAccess already would: not bound.
		expect((await syncUserInstallations(env, "u2", { owner: "acme" })).orgs).toEqual([expect.objectContaining({ account: "acme", result: "not_bound", reason: "not_member", status: 404 })]);
		expect(bindings("u2")).toEqual([]);
	});

	it("no linked GitHub login: nothing is bound, and the reason says so", async () => {
		const r = await syncUserInstallations(env, "u3", { owner: "acme" });
		expect(r.githubLogin).toBe("nolink@example.com");
		expect(r.orgs).toEqual([expect.objectContaining({ account: "acme", result: "not_bound" })]);
		expect(bindings("u3")).toEqual([]);
	});

	it("a refused mint is reported, and nothing is bound for it", async () => {
		fake.mintRefused.add(2);
		const r = await syncUserInstallations(env, "u1", { owner: "acme" });
		expect(r.orgs).toEqual([expect.objectContaining({ account: "acme", result: "not_bound", reason: "mint_failed" })]);
		expect(bindings("u1")).toEqual([7]);
	});
});

describe("bindMemberOrgInstallations (the link flow) — every outcome, never a silent skip", () => {
	it("PARTIAL: binds the active membership, and reports the org that refused the read with GitHub's reason", async () => {
		fake.userMembership = {
			acme: { status: 200, body: { state: "active" } },
			"chessclubs-online": { status: 403, body: { message: "Although you appear to have the correct authorization credentials, the `chessclubs-online` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited." } },
		};
		const r = await bindMemberOrgInstallations(env, "u1", "octo", "gho_user_token");
		expect(r.bound.sort()).toEqual(["acme", "octo"]);
		expect(r.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ account: "chessclubs-online", result: "not_bound", reason: "oauth_app_restricted", status: 403 })]));
		expect(bindings("u1")).toEqual([1, 2, 7]);
		// What the link flow may TELL: its own orgs by name, the refusal as a count — not the org's name.
		const told = disclosedOutcomes(r.outcomes);
		expect(told.orgs.map((o) => o.account).sort()).toEqual(["acme", "octo"]);
		expect(told.unnamed).toEqual({ oauth_app_restricted: 1 });
		expect(JSON.stringify(told)).not.toMatch(/chessclubs|other-co|someone-else|gho_/);
	});

	it("a pending invitation is not a membership — not bound, and named as pending", async () => {
		fake.userMembership = { "pending-co": { status: 200, body: { state: "pending" } } };
		const r = await bindMemberOrgInstallations(env, "u1", "octo", "gho_user_token");
		expect(r.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ account: "pending-co", result: "not_bound", reason: "membership_pending" })]));
		expect(bindings("u1")).not.toContain(6);
	});

	it("a failed mint for an active org is reported, not swallowed", async () => {
		fake.userMembership = { acme: { status: 200, body: { state: "active" } } };
		fake.mintRefused.add(2);
		const r = await bindMemberOrgInstallations(env, "u1", "octo", "gho_user_token");
		expect(r.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ account: "acme", result: "not_bound", reason: "mint_failed" })]));
		expect(r.bound).not.toContain("acme");
	});

	it("an unreadable installation list FAILS — it is no longer turned into 'nothing to bind'", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 502 })));
		await expect(bindMemberOrgInstallations(env, "u1", "octo", "gho_user_token")).rejects.toThrow(/installations 502/);
	});
});

describe("POST /v1/github/installations/sync — the console's and MCP's one door", () => {
	const post = (body: unknown, e: Env = env) => githubRoutes.request("/installations/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, e);

	it("names the org it was asked about, and the reply carries the browser re-link for what the App could not verify", async () => {
		const res = await post({ owner: "chessclubs-online", dry_run: true });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ owner: "chessclubs-online", dryRun: true, bound: 0, linkStart: "/v1/auth/github/link/start", orgs: [{ account: "chessclubs-online", result: "not_bound", reason: "app_cannot_read_members", status: 403 }] });
		expect(d1.sqlite.prepare("SELECT count(*) AS n FROM agent_events WHERE event = 'github.installations_sync'").get()).toEqual({ n: 1 });
	});

	it("refuses an owner that is not a GitHub login, before anything is checked", async () => {
		expect((await post({ owner: "https://evil.example/x" })).status).toBe(400);
		expect(fake.calls).toEqual([]);
	});

	it("is inert (503) on a deployment without the App", async () => {
		expect((await post({}, { DB: d1.DB } as unknown as Env)).status).toBe(503);
	});
});
